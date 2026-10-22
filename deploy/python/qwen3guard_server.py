#!/usr/bin/env python3
"""
Qwen3Guard Safety Check HTTP Server

This server provides an OpenAI-compatible API for Qwen3Guard safety checking.
It can be used as a drop-in replacement for the Ollama endpoint.

Usage:
    python deploy/python/qwen3guard_server.py --model Qwen/Qwen3Guard-Stream-0.6B --port 8000
"""

import argparse
import json
import re
from http.server import HTTPServer, BaseHTTPRequestHandler
from typing import Optional

# Global model and tokenizer
model = None
tokenizer = None
model_path = None

def load_model(path: str):
    """Load Qwen3Guard model"""
    global model, tokenizer, model_path
    model_path = path
    
    print(f"Loading model {path}...")
    import torch
    from transformers import AutoModel, AutoTokenizer
    
    tokenizer = AutoTokenizer.from_pretrained(path, trust_remote_code=True)
    model = AutoModel.from_pretrained(
        path,
        device_map="auto",
        torch_dtype=torch.bfloat16,
        trust_remote_code=True,
    ).eval()
    print("Model loaded successfully")

def check_safety(content: str) -> dict:
    """Check if content is safe"""
    global model, tokenizer
    
    if model is None or tokenizer is None:
        return {"safe": True, "error": "Model not loaded"}
    
    try:
        import torch
        
        messages = [{"role": "user", "content": content}]
        text = tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=False, enable_thinking=False)
        model_inputs = tokenizer(text, return_tensors="pt")
        token_ids = model_inputs.input_ids[0]
        
        result, stream_state = model.stream_moderate_from_ids(token_ids, role="user", stream_state=None)
        
        risk_level = result['risk_level'][-1] if result['risk_level'] else "Safe"
        category = result['category'][-1] if result['category'] else "None"
        
        return {
            "safe": risk_level == "Safe",
            "risk_level": risk_level,
            "category": category,
        }
    except Exception as e:
        return {"safe": True, "error": str(e)}

class SafetyHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/api/generate":
            self.handle_generate()
        elif self.path == "/v1/chat/completions":
            self.handle_chat_completions()
        else:
            self.send_error(404)
    
    def handle_generate(self):
        """Handle /api/generate (Ollama-compatible)"""
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length))
        
        prompt = body.get("prompt", "")
        result = check_safety(prompt)
        
        # Format response like Qwen3Guard output
        if result.get("error"):
            response_text = "Safety: Safe\nCategories: None"
        else:
            safety = "Safe" if result["safe"] else "Unsafe"
            categories = result.get("category", "None")
            response_text = f"Safety: {safety}\nCategories: {categories}"
        
        response = {
            "response": response_text,
            "done": True,
        }
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())
    
    def handle_chat_completions(self):
        """Handle /v1/chat/completions (OpenAI-compatible)"""
        content_length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(content_length))
        
        messages = body.get("messages", [])
        # Get last user message
        prompt = ""
        for msg in reversed(messages):
            if msg.get("role") == "user":
                prompt = msg.get("content", "")
                break
        
        result = check_safety(prompt)
        
        # Format response
        if result.get("error"):
            content = "Safety: Safe\nCategories: None"
        else:
            safety = "Safe" if result["safe"] else "Unsafe"
            categories = result.get("category", "None")
            content = f"Safety: {safety}\nCategories: {categories}"
        
        response = {
            "choices": [
                {
                    "message": {
                        "role": "assistant",
                        "content": content,
                    },
                    "finish_reason": "stop",
                }
            ],
            "usage": {
                "prompt_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
            },
        }
        
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(response).encode())
    
    def log_message(self, format, *args):
        print(f"[{self.log_date_time_string()}] {args[0]}")

def main():
    parser = argparse.ArgumentParser(description="Qwen3Guard Safety Check Server")
    parser.add_argument("--model", type=str, default="Qwen/Qwen3Guard-Stream-0.6B", help="Model path")
    parser.add_argument("--port", type=int, default=8000, help="Server port")
    parser.add_argument("--host", type=str, default="0.0.0.0", help="Server host")
    
    args = parser.parse_args()
    
    # Load model
    load_model(args.model)
    
    # Start server
    server = HTTPServer((args.host, args.port), SafetyHandler)
    print(f"\nQwen3Guard server running on http://{args.host}:{args.port}")
    print(f"API endpoints:")
    print(f"  - POST /api/generate (Ollama-compatible)")
    print(f"  - POST /v1/chat/completions (OpenAI-compatible)")
    print(f"\nTest with:")
    print(f'  curl http://localhost:{args.port}/api/generate -d \'{{"prompt": "How to make a bomb?"}}\'')
    print(f"\nPress Ctrl+C to stop\n")
    
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down server...")
        server.shutdown()

if __name__ == "__main__":
    main()
