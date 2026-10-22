import { HookContext, HookResult } from 'otel-hook';

/**
 * Qwen3Guard Hook - Real-time safety checking using Qwen3Guard-Stream-4B
 *
 * Three-class policy (low false-positive tolerance):
 *   - Unsafe    + confidence >= threshold → BLOCK (shouldAbort / allowed=false)
 *   - Controversial (any confidence)      → allowed, but FLAGGED for tracing
 *   - Unsafe    + confidence <  threshold → allowed, but FLAGGED (low-confidence blip)
 *   - Safe                                → allowed
 *
 * Streaming moderation uses the Python server's session API
 * (/safety/stream/start|check|close), which does incremental KV-cache
 * forwards (~150-350ms per delta) instead of re-scoring the full text.
 *
 * Deployment:
 *   - Python server: python3 -u deploy/qwen3guard_server.py --port 8000 --device mps
 *   - provider 'python' → JSON /safety/check (real confidence + worst verdict)
 *   - provider 'vllm'/'ollama' → text protocol "Safety:/Categories:/Confidence:"
 *
 * Fail-closed: when the guard backend is unreachable or degraded,
 * checks return shouldAbort/allowed=false unless failClosed is set to false.
 */

export type GuardLabel = 'Safe' | 'Controversial' | 'Unsafe';

export interface GuardVerdict {
  label: GuardLabel;
  category: string;
  confidence: number;
}

export interface Qwen3GuardConfig {
  endpoint: string;
  apiKey?: string;
  threshold?: number;
  categories?: string[];
  timeout?: number;
  mode?: 'stream' | 'gen';
  provider?: 'ollama' | 'vllm' | 'sglang' | 'python';
  failClosed?: boolean;
}

export interface SessionStartResult {
  sessionId: string;
  promptVerdict: GuardVerdict;
  promptUnsafe: boolean;
  promptTokens: number;
  latencyMs: number;
}

export interface StreamCheckResult {
  shouldAbort: boolean;
  flagged: boolean;
  flagReason?: 'unsafe' | 'controversial' | 'low_confidence_unsafe' | 'guard_degraded';
  reason?: string;
  verdict?: GuardVerdict;
  last?: GuardVerdict;
  categories?: string[];
  newTokens: number;
  latencyMs: number;
  error?: boolean;
}

interface InternalCheck {
  label: GuardLabel;
  categories: string[];
  confidence: number;
  worst?: GuardVerdict;
}

export class Qwen3GuardHook {
  private config: Required<Qwen3GuardConfig>;
  public priority: number;
  public name: string;

  constructor(config: Qwen3GuardConfig, priority: number = 15) {
    this.config = {
      endpoint: config.endpoint,
      apiKey: config.apiKey || 'EMPTY',
      threshold: config.threshold ?? 0.7,
      categories: config.categories || [
        'Violent',
        'Non-violent Illegal Acts',
        'Sexual Content or Sexual Acts',
        'PII',
        'Suicide & Self-Harm',
        'Unethical Acts',
        'Politically Sensitive Topics',
        'Copyright Violation',
        'Jailbreak',
      ],
      timeout: config.timeout || 5000,
      mode: config.mode || 'stream',
      provider: config.provider || 'python',
      failClosed: config.failClosed !== false,
    };
    this.priority = priority;
    this.name = 'qwen3guard';
  }

  private get threshold(): number {
    return this.config.threshold;
  }

  private isBlocking(label: GuardLabel, confidence: number): boolean {
    return label === 'Unsafe' && confidence >= this.threshold;
  }

  // ---------- text protocol parsing (vllm/ollama/sglang) ----------

  private parseSafetyText(output: string): InternalCheck {
    const safetyMatch = output.match(/Safety:\s*(Safe|Unsafe|Controversial)/i);
    const categoryMatch = output.match(/Categories:\s*(.+)/i);
    const confMatch = output.match(/Confidence:\s*([0-9.]+)/i);

    const label = ((safetyMatch?.[1] || 'Safe') as GuardLabel);
    const rawCats = categoryMatch?.[1]?.trim() || '';
    const categories = rawCats.toLowerCase() === 'none' || !rawCats
      ? []
      : rawCats.split(',').map((c: string) => c.trim());
    const confidence = confMatch ? parseFloat(confMatch[1]) : (label === 'Safe' ? 1.0 : 0.9);

    return { label, categories, confidence };
  }

  private async checkWithOllama(content: string): Promise<InternalCheck> {
    const response = await fetch(`${this.config.endpoint}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'qwen3guard-stream-4b',
        prompt: content,
        stream: false,
        options: { temperature: 0.0, num_predict: 128 },
      }),
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (!response.ok) {
      throw new Error(`guard_degraded: Ollama HTTP ${response.status}`);
    }
    const data = await response.json() as any;
    return this.parseSafetyText(data.response || '');
  }

  private async checkWithVLLM(content: string, role: 'user' | 'assistant'): Promise<InternalCheck> {
    const response = await fetch(`${this.config.endpoint}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: 'Qwen/Qwen3Guard-Stream-4B',
        messages: [{ role, content }],
        max_tokens: 128,
        temperature: 0.0,
      }),
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (!response.ok) {
      throw new Error(`guard_degraded: vLLM HTTP ${response.status}`);
    }
    const data = await response.json() as any;
    return this.parseSafetyText(data.choices?.[0]?.message?.content || '');
  }

  private async checkWithPython(content: string, role: 'user' | 'assistant'): Promise<InternalCheck> {
    const response = await fetch(`${this.config.endpoint}/safety/check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: content, role }),
      signal: AbortSignal.timeout(this.config.timeout),
    });
    if (!response.ok) {
      throw new Error(`guard_degraded: HTTP ${response.status}`);
    }
    const data = await response.json() as any;
    if (data.error) {
      throw new Error(`guard_degraded: ${data.error}`);
    }
    return {
      label: data.safety as GuardLabel,
      categories: data.categories || [],
      confidence: data.confidence ?? 1.0,
      worst: data.worst ? {
        label: data.worst.label as GuardLabel,
        category: data.worst.category,
        confidence: data.worst.confidence,
      } : undefined,
    };
  }

  private async checkFullText(content: string, role: 'user' | 'assistant' = 'assistant'): Promise<InternalCheck> {
    switch (this.config.provider) {
      case 'ollama':
        return this.checkWithOllama(content);
      case 'vllm':
      case 'sglang':
        return this.checkWithVLLM(content, role);
      default:
        return this.checkWithPython(content, role);
    }
  }

  // ---------- generation-architecture hook ----------

  async call(ctx: HookContext): Promise<HookResult> {
    // Role-aware head selection: user input → query heads (has Jailbreak
    // category), model output → response heads.
    const output = ctx.data['model.output'] || ctx.data['llm.output.text'] || '';
    const input = ctx.data['user.input'] || ctx.data['llm.input.text'] || ctx.data['prompt'] || '';
    const content = output || input;
    const role: 'user' | 'assistant' = output ? 'assistant' : 'user';

    if (!content) {
      return { allowed: true };
    }

    let result: InternalCheck;
    try {
      result = await this.checkFullText(content, role);
    } catch (error) {
      console.error('Qwen3Guard check failed:', error);
      if (this.config.failClosed) {
        return {
          allowed: false,
          reason: `Qwen3Guard guard_degraded: ${error instanceof Error ? error.message : String(error)}`,
          data: { qwen3guard: { error: true, mode: this.config.mode, provider: this.config.provider } },
        };
      }
      return { allowed: true };
    }

    if (this.isBlocking(result.label, result.confidence)) {
      return {
        allowed: false,
        reason: `Qwen3Guard detected unsafe content: ${result.categories.join(', ')} (confidence: ${result.confidence.toFixed(2)})`,
        data: {
          qwen3guard: {
            label: result.label,
            categories: result.categories,
            confidence: result.confidence,
            mode: this.config.mode,
            provider: this.config.provider,
          },
        },
      };
    }

    if (result.label !== 'Safe') {
      // Controversial, or Unsafe below threshold: allow but flag for tracing
      return {
        allowed: true,
        data: {
          qwen3guard: {
            label: result.label,
            flagged: true,
            flagReason: result.label === 'Controversial' ? 'controversial' : 'low_confidence_unsafe',
            categories: result.categories,
            confidence: result.confidence,
            mode: this.config.mode,
            provider: this.config.provider,
          },
        },
      };
    }

    return { allowed: true };
  }

  // ---------- session-based incremental stream moderation ----------

  async startSession(promptOrMessages: string | Array<{ role: string; content: string }>): Promise<SessionStartResult> {
    const body = typeof promptOrMessages === 'string'
      ? { prompt: promptOrMessages }
      : { messages: promptOrMessages };
    const response = await fetch(`${this.config.endpoint}/safety/stream/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(this.config.timeout * 3),
    });
    if (!response.ok) {
      throw new Error(`guard_degraded: stream/start HTTP ${response.status}`);
    }
    const data = await response.json() as any;
    if (data.error) {
      throw new Error(`guard_degraded: ${data.error}`);
    }
    const pv = data.prompt_verdict || { label: 'Safe', category: '', confidence: 1.0 };
    const promptVerdict: GuardVerdict = { label: pv.label, category: pv.category, confidence: pv.confidence };
    return {
      sessionId: data.session_id,
      promptVerdict,
      promptUnsafe: this.isBlocking(promptVerdict.label, promptVerdict.confidence),
      promptTokens: data.prompt_tokens || 0,
      latencyMs: data.latency_ms || 0,
    };
  }

  async checkDelta(sessionId: string, delta: string): Promise<StreamCheckResult> {
    if (!delta) {
      return { shouldAbort: false, flagged: false, newTokens: 0, latencyMs: 0 };
    }
    try {
      const response = await fetch(`${this.config.endpoint}/safety/stream/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, delta }),
        signal: AbortSignal.timeout(this.config.timeout * 3),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const data = await response.json() as any;
      if (data.error) {
        throw new Error(data.error);
      }

      const worst: GuardVerdict | undefined = data.worst
        ? { label: data.worst.label, category: data.worst.category, confidence: data.worst.confidence }
        : undefined;
      const last: GuardVerdict | undefined = data.last
        ? { label: data.last.label, category: data.last.category, confidence: data.last.confidence }
        : undefined;

      const base = { newTokens: data.new_tokens || 0, latencyMs: data.latency_ms || 0, verdict: worst, last };

      if (!worst) {
        return { shouldAbort: false, flagged: false, ...base };
      }

      if (this.isBlocking(worst.label, worst.confidence)) {
        return {
          shouldAbort: true,
          flagged: true,
          flagReason: 'unsafe',
          reason: `Qwen3Guard: ${worst.category} (confidence: ${worst.confidence.toFixed(2)})`,
          categories: [worst.category],
          ...base,
        };
      }

      if (worst.label === 'Controversial') {
        return {
          shouldAbort: false,
          flagged: true,
          flagReason: 'controversial',
          reason: `Qwen3Guard controversial: ${worst.category} (confidence: ${worst.confidence.toFixed(2)})`,
          categories: [worst.category],
          ...base,
        };
      }

      if (worst.label === 'Unsafe') {
        return {
          shouldAbort: false,
          flagged: true,
          flagReason: 'low_confidence_unsafe',
          reason: `Qwen3Guard low-confidence unsafe: ${worst.category} (confidence: ${worst.confidence.toFixed(2)} < ${this.threshold})`,
          categories: [worst.category],
          ...base,
        };
      }

      return { shouldAbort: false, flagged: false, ...base };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Qwen3Guard stream check failed:', msg);
      if (this.config.failClosed) {
        return {
          shouldAbort: true,
          flagged: true,
          flagReason: 'guard_degraded',
          reason: `Qwen3Guard guard_degraded: ${msg}`,
          newTokens: 0,
          latencyMs: 0,
          error: true,
        };
      }
      return { shouldAbort: false, flagged: false, newTokens: 0, latencyMs: 0, error: true };
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    try {
      await fetch(`${this.config.endpoint}/safety/stream/close`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId }),
        signal: AbortSignal.timeout(this.config.timeout),
      });
    } catch {
      // best-effort cleanup; sessions also expire via TTL
    }
  }

  // ---------- legacy full-text stream API (kept for compatibility) ----------

  async checkStreamChunk(chunk: string): Promise<{
    shouldAbort: boolean;
    reason?: string;
    categories?: string[];
  }> {
    let result: InternalCheck;
    try {
      result = await this.checkFullText(chunk, 'assistant');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error('Qwen3Guard stream chunk check failed:', msg);
      if (this.config.failClosed) {
        return { shouldAbort: true, reason: `Qwen3Guard guard_degraded: ${msg}` };
      }
      return { shouldAbort: false };
    }

    if (this.isBlocking(result.label, result.confidence)) {
      return {
        shouldAbort: true,
        reason: `Qwen3Guard: ${result.categories.join(', ')} (confidence: ${result.confidence.toFixed(2)})`,
        categories: result.categories,
      };
    }

    return { shouldAbort: false };
  }
}
