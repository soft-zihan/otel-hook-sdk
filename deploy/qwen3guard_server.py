#!/usr/bin/env python3
"""
Qwen3Guard-Stream-4B HTTP Server — session-based incremental moderation.

Design (v2):
  - Custom incremental forward with KV cache (the model's own
    stream_moderate_from_ids is broken on transformers 4.57: it re-feeds the
    full sequence each send → ~300ms/token AND corrupted verdicts).
    Our path sends only new tokens with cache_position + 4D mask →
    ~150-350ms per delta check, verdicts match full-sequence reference.
  - Three-class policy: Safe / Controversial / Unsafe with REAL confidence.
    Clients decide: Unsafe+conf>=threshold → block; Controversial → flag only.
  - Correct heads: query heads for user prompts, response heads for assistant
    output (previous version used query heads for everything → FPs).
  - Fail-closed: degenerate GPU output (zero/NaN logits under memory pressure)
    → explicit 503, never a fake "Safe".

Endpoints:
  POST /safety/stream/start  {prompt | messages}        → session + prompt verdict
  POST /safety/stream/check  {session_id, delta}        → incremental verdicts
  POST /safety/stream/close  {session_id}
  POST /safety/check         {input, role?}             → one-shot full-text
  POST /v1/chat/completions  (OpenAI-compatible, response-head moderation)

Usage:
  python3 -u deploy/qwen3guard_server.py --port 8000 --device mps
"""

import json
import time
import uuid
import argparse
import threading
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from typing import Optional

try:
    import torch
    from transformers import AutoModel, AutoTokenizer
    HAS_TRANSFORMERS = True
except ImportError:
    HAS_TRANSFORMERS = False
    print("Warning: transformers not installed. Install with: pip install transformers torch")

RANK = {'Safe': 0, 'Controversial': 1, 'Unsafe': 2}

# config short names → official Qwen3Guard category names
CATEGORY_MAP = {
    'Violent': 'Violent',
    'Illegal Acts': 'Non-violent Illegal Acts',
    'Sexual Content': 'Sexual Content or Sexual Acts',
    'Sexual': 'Sexual Content or Sexual Acts',
    'PII': 'PII',
    'Self-Harm': 'Suicide & Self-Harm',
    'Unethical': 'Unethical Acts',
    'Political': 'Politically Sensitive Topics',
    'Copyright': 'Copyright Violation',
    'Jailbreak': 'Jailbreak',
}


def norm_category(c: str) -> str:
    return CATEGORY_MAP.get(c, c)


class Qwen3GuardModel:
    """Qwen3Guard-Stream-4B wrapper with correct incremental (KV-cache) streaming."""

    def __init__(self, model_path: str, device: str = "auto"):
        if not HAS_TRANSFORMERS:
            raise RuntimeError("transformers not installed")

        print(f"Loading model from {model_path}...")
        self.tokenizer = AutoTokenizer.from_pretrained(model_path, trust_remote_code=True)

        if device == "auto":
            if torch.backends.mps.is_available():
                device = "mps"
            elif torch.cuda.is_available():
                device = "cuda"
            else:
                device = "cpu"
        self.device = device
        print(f"Using device: {device}")

        if device == "mps":
            # bf16 required on MPS: fp32 (16GB) exceeds GPU memory; fp16 → NaN → KeyError -1
            self.model = AutoModel.from_pretrained(
                model_path, device_map={"": "mps"}, torch_dtype=torch.bfloat16,
                trust_remote_code=True, low_cpu_mem_usage=True,
            ).eval()
        else:
            self.model = AutoModel.from_pretrained(
                model_path, device_map=device, torch_dtype=torch.bfloat16,
                trust_remote_code=True, low_cpu_mem_usage=True,
            ).eval()

        self.gpu_lock = threading.Lock()
        print("Model loaded successfully")

        # Keepalive: under memory pressure macOS pages out idle MPS buffers,
        # making the first forward after an idle gap 3-30x slower (measured
        # 434ms-30s cold vs ~160-350ms warm). A tiny forward every 3s keeps
        # weights resident. Serialized via gpu_lock so real checks never race.
        self._keepalive_stop = threading.Event()
        ka = threading.Thread(target=self._keepalive_loop, daemon=True)
        ka.start()

        print("Warming up...")
        t0 = time.time()
        ok = False
        for attempt in range(5):
            try:
                r = self.check_full("Hello, how are you?", role="user")
                if not r["degenerate"]:
                    sid = None
                    try:
                        s = self.session_start([{"role": "user", "content": "Hi"}])
                        sid = s["session_id"]
                        c = self.session_check(sid, " there! How can I help?")
                        ok = not c["degenerate"]
                    finally:
                        if sid:
                            self.session_close(sid)
                if ok:
                    break
            except RuntimeError as e:
                print(f"Warmup attempt {attempt + 1} failed: {e}")
            if torch.backends.mps.is_available():
                torch.mps.empty_cache()
            time.sleep(2 * (attempt + 1))
        if not ok:
            print("FATAL: model degraded after 5 warmup attempts. Free RAM and restart. Exiting.")
            import os
            os._exit(2)
        print(f"Warmup done in {time.time() - t0:.2f}s")

    def _keepalive_loop(self):
        try:
            ids = self.tokenizer("hi", return_tensors="pt").input_ids[0][:4].to(self.model.device)
        except Exception:
            return
        while not self._keepalive_stop.wait(3):
            try:
                with self.gpu_lock:
                    self._forward_fresh(ids)
            except Exception:
                self._retry_cache()

    # ---------- core forward primitives ----------

    @torch.no_grad()
    def _forward_fresh(self, ids: torch.Tensor):
        n = len(ids)
        mask = torch.tril(torch.ones((n, n), device=ids.device, dtype=torch.bool)).unsqueeze(0).unsqueeze(0)
        return self.model.forward(
            input_ids=ids.unsqueeze(0), attention_mask=mask,
            cache_position=torch.arange(n, device=ids.device), use_cache=True,
        )

    @torch.no_grad()
    def _forward_delta(self, past, length: int, new_ids: torch.Tensor):
        """Incremental forward: only new tokens, KV cache reused. 4D bool mask (1,1,k,L+k)."""
        k = len(new_ids)
        dev = new_ids.device
        mask = torch.zeros((1, 1, k, length + k), device=dev, dtype=torch.bool)
        mask[0, 0, :, :length] = True
        mask[0, 0][:, length:] = torch.tril(torch.ones((k, k), device=dev, dtype=torch.bool))
        pos = torch.arange(length, length + k, device=dev)
        return self.model.forward(
            input_ids=new_ids.unsqueeze(0), attention_mask=mask,
            past_key_values=past, cache_position=pos, use_cache=True,
        )

    def _read_verdicts(self, out, role: str):
        """Per-position verdicts from the correct head, computed on CPU float32.

        MPS quirk: torch.max on all-NaN rows returns -1 (CPU returns 0), and
        masked positions produce all -inf logits → NaN softmax. Filter them.
        Returns list of dicts (label, category, confidence) for valid positions.
        """
        if role == "user":
            rl, cat = out.query_risk_level_logits, out.query_category_logits
            rmap, cmap = self.model.query_risk_level_map, self.model.query_category_map
        else:
            rl, cat = out.risk_level_logits, out.category_logits
            rmap, cmap = self.model.response_risk_level_map, self.model.response_category_map

        rp = torch.softmax(rl.squeeze(0).float().cpu(), dim=-1)
        cp = torch.softmax(cat.squeeze(0).float().cpu(), dim=-1)
        verdicts = []
        for i in range(rp.shape[0]):
            row = rp[i]
            if torch.isnan(row).all() or row.std() == 0:
                continue
            pv, pi = torch.max(row, dim=-1)
            cv, ci = torch.max(cp[i], dim=-1)
            label = rmap[int(pi)]
            verdicts.append({
                "label": label,
                "category": norm_category(cmap[int(ci)]),
                "confidence": round(float(pv), 4),
            })
        return verdicts

    @staticmethod
    def _degenerate(verdicts) -> bool:
        return len(verdicts) == 0

    def _retry_cache(self):
        if torch.backends.mps.is_available():
            torch.mps.empty_cache()

    # ---------- one-shot full-text check ----------

    def check_full(self, text: str, role: str = "user") -> dict:
        """Full-text moderation. role='user' → query heads on a chat-templated
        prompt; role='assistant' → response heads (neutral prompt + text as reply)."""
        for attempt in range(3):
            with self.gpu_lock:
                if role == "assistant":
                    head = self.tokenizer.apply_chat_template(
                        [{"role": "user", "content": "Respond to the user."}],
                        tokenize=False, add_generation_prompt=True, enable_thinking=False)
                    full = head + text
                else:
                    full = self.tokenizer.apply_chat_template(
                        [{"role": "user", "content": text}],
                        tokenize=False, add_generation_prompt=False, enable_thinking=False)
                ids = self.tokenizer(full, return_tensors="pt").input_ids[0].to(self.model.device)
                t0 = time.time()
                out = self._forward_fresh(ids)
                verdicts = self._read_verdicts(out, role)
                latency = (time.time() - t0) * 1000
            if not self._degenerate(verdicts):
                last = verdicts[-1]
                worst = max(verdicts, key=lambda v: (RANK.get(v["label"], 0), v["confidence"]))
                cats = "None" if last["label"] == "Safe" else last["category"]
                return {
                    "safety": last["label"],
                    "categories": [] if last["label"] == "Safe" else [last["category"]],
                    "confidence": last["confidence"],
                    "worst": worst,
                    "raw_output": f"Safety: {last['label']}\nCategories: {cats}\nConfidence: {last['confidence']:.2f}",
                    "is_safe": last["label"] == "Safe",
                    "degenerate": False,
                    "role": role,
                    "latency_ms": round(latency, 1),
                }
            if attempt < 2:
                self._retry_cache()
                time.sleep(0.5)
        raise RuntimeError("model_degraded: GPU returned zero/NaN logits after 3 attempts. Refusing to fail open.")

    # ---------- session-based incremental streaming ----------

    _sessions: dict = {}
    _sessions_lock = threading.Lock()
    MAX_SESSIONS = 32
    SESSION_TTL = 900

    def session_start(self, messages) -> dict:
        with self._sessions_lock:
            self._evict_sessions()
            sid = uuid.uuid4().hex[:16]
        prompt_text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=False)
        ids = self.tokenizer(prompt_text, return_tensors="pt").input_ids[0].to(self.model.device)
        for attempt in range(3):
            with self.gpu_lock:
                t0 = time.time()
                out = self._forward_fresh(ids)
                verdicts = self._read_verdicts(out, "user")
                latency = (time.time() - t0) * 1000
            if not self._degenerate(verdicts):
                break
            if attempt < 2:
                self._retry_cache()
                time.sleep(0.5)
        if self._degenerate(verdicts):
            raise RuntimeError("model_degraded on session start")
        with self._sessions_lock:
            self._sessions[sid] = {
                "past": out.past_key_values,
                "length": len(ids),
                "tokens_sent": len(ids),
                "prompt_text": prompt_text,
                "response_text": "",
                "created": time.time(),
            }
        last = verdicts[-1]
        return {
            "session_id": sid,
            "prompt_verdict": last,
            "prompt_tokens": len(ids),
            "degenerate": False,
            "latency_ms": round(latency, 1),
        }

    def session_check(self, sid: str, delta: str) -> dict:
        with self._sessions_lock:
            sess = self._sessions.get(sid)
            if sess is None:
                raise KeyError(f"unknown session_id: {sid}")
        sess["response_text"] += delta
        # Re-tokenize the full visible text so token boundaries stay aligned
        # with a single-pass forward (streaming-safe).
        full_ids = self.tokenizer(sess["prompt_text"] + sess["response_text"],
                                  return_tensors="pt").input_ids[0].to(self.model.device)
        new_ids = full_ids[sess["tokens_sent"]:]
        if len(new_ids) == 0:
            return {"new_tokens": 0, "verdicts": [], "last": None, "worst": None,
                    "degenerate": False, "latency_ms": 0.0}
        for attempt in range(3):
            with self.gpu_lock:
                t0 = time.time()
                out = self._forward_delta(sess["past"], sess["length"], new_ids)
                verdicts = self._read_verdicts(out, "assistant")
                latency = (time.time() - t0) * 1000
            if not self._degenerate(verdicts):
                sess["past"] = out.past_key_values
                sess["length"] += len(new_ids)
                sess["tokens_sent"] = len(full_ids)
                worst = max(verdicts, key=lambda v: (RANK.get(v["label"], 0), v["confidence"]))
                return {
                    "new_tokens": int(len(new_ids)),
                    "verdicts": verdicts,
                    "last": verdicts[-1],
                    "worst": worst,
                    "degenerate": False,
                    "latency_ms": round(latency, 1),
                }
            if attempt < 2:
                self._retry_cache()
                time.sleep(0.5)
        raise RuntimeError("model_degraded on session check")

    def session_close(self, sid: str):
        with self._sessions_lock:
            sess = self._sessions.pop(sid, None)
        if sess is not None:
            sess["past"] = None

    def _evict_sessions(self):
        now = time.time()
        stale = [k for k, v in self._sessions.items() if now - v["created"] > self.SESSION_TTL]
        for k in stale:
            self._sessions.pop(k, None)
        while len(self._sessions) >= self.MAX_SESSIONS:
            oldest = min(self._sessions, key=lambda k: self._sessions[k]["created"])
            self._sessions.pop(oldest, None)


class SafetyHandler(BaseHTTPRequestHandler):
    model: Optional[Qwen3GuardModel] = None

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length).decode('utf-8')
        try:
            data = json.loads(body) if body else {}
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return
        try:
            if self.path == '/safety/stream/start':
                self._json_out(self.handle_stream_start(data))
            elif self.path == '/safety/stream/check':
                self._json_out(self.model.session_check(data['session_id'], data.get('delta', '')))
            elif self.path == '/safety/stream/close':
                self.model.session_close(data.get('session_id', ''))
                self._json_out({"ok": True})
            elif self.path == '/safety/check':
                text = data.get('input', data.get('text', ''))
                if not text:
                    self.send_error(400, "No input text")
                    return
                self._json_out(self.model.check_full(text, role=data.get('role', 'user')))
            elif self.path == '/v1/chat/completions':
                self.handle_chat_completions(data)
            else:
                self.send_error(404, "Not found")
        except KeyError as e:
            self._json_out({"error": "bad_request", "detail": str(e)}, status=400)
        except Exception as e:
            # Fail closed: never a fake "Safe", never a dropped connection
            self._json_out({"error": "guard_degraded",
                            "detail": f"{type(e).__name__}: {e}"}, status=503)

    def handle_stream_start(self, data: dict) -> dict:
        messages = data.get('messages')
        if not messages:
            prompt = data.get('prompt', '')
            if not prompt:
                raise KeyError("need 'messages' or 'prompt'")
            messages = [{"role": "user", "content": prompt}]
        return self.model.session_start(messages)

    def handle_chat_completions(self, data: dict):
        messages = data.get('messages', [])
        text = '\n'.join([m.get('content', '') for m in messages if m.get('content')])
        if not text:
            self.send_error(400, "No content in messages")
            return
        # Role-aware head selection: last message role decides query heads
        # (user input, includes Jailbreak category) vs response heads
        # (assistant output moderation).
        role = 'assistant'
        for m in reversed(messages):
            if m.get('content'):
                role = 'user' if m.get('role') == 'user' else 'assistant'
                break
        result = self.model.check_full(text, role=role)
        response = {
            "id": "chatcmpl-guard",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": "Qwen/Qwen3Guard-Stream-4B",
            "choices": [{
                "index": 0,
                "message": {"role": "assistant", "content": result["raw_output"]},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }
        self._json_out(response)

    def _json_out(self, obj, status=200):
        payload = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {args[0]}")


def main():
    parser = argparse.ArgumentParser(description='Qwen3Guard Safety Server (incremental streaming)')
    parser.add_argument('--port', type=int, default=8000)
    parser.add_argument('--model-path', type=str,
                        default='/Users/han/.cache/modelscope/models/Qwen--Qwen3Guard-Stream-4B/snapshots/master')
    parser.add_argument('--device', type=str, default='auto')
    args = parser.parse_args()

    model = Qwen3GuardModel(args.model_path, args.device)
    SafetyHandler.model = model

    server = ThreadingHTTPServer(('0.0.0.0', args.port), SafetyHandler)
    print(f"\nQwen3Guard server running on http://localhost:{args.port}")
    print("Endpoints: /safety/stream/start|check|close, /safety/check, /v1/chat/completions")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down...")
        server.server_close()


if __name__ == '__main__':
    main()
