/**
 * StreamGuard — 三门流式安全防线（agent 无关，可配置）
 *
 *   门1 input_gen     : 用户输入送主模型前审核，Unsafe(conf>=threshold) → 拦截，主模型零调用
 *   门2 output_stream : 主模型流式输出按句子边界增量审核（hold-back：最后一句扣住不发布，过检才放行）
 *   门3 output_gen    : 流自然结束后剩余 hold-back 文本终检（发布门）
 *
 * 核心语义：发布给用户的每个字符都已过检；拦截 = 零暴露。
 * fail-closed（默认）：审核后端异常 → 视为拦截，绝不假 Safe；可配 failMode:'open' 降级放行。
 *
 * 每次检测发射 Langfuse 兼容的 GUARDRAIL span（hook.SafeGuard.<gate>#<seq>），
 * 携带 wall_ms / server_latency_ms / verdict / 拦截点 / 被拦截原文等归因字段。
 *
 * 与具体 agent 框架解耦：
 *   - 低层 API：startTurn(history) / push(delta) / finish() / close()
 *   - 高层 API：runGuardedStream(source, guard) 包装任意 AsyncIterable<string> 流
 *   - 后端可替换：实现 GuardBackend 结构化接口即可（默认 Qwen3GuardHook）
 *
 * 用法（任意 agent）：
 *   const guard = createStreamGuard({ endpoint: 'http://localhost:8000', sessionId, userId, parentContext })
 *   const g = await guard.startTurn(messages)          // 门1
 *   if (g.blocked) return showBlockNotice(g.reason)
 *   const result = await runGuardedStream(llmDeltas, guard, { onRelease: chunk => render(chunk) })
 *   if (result.outcome === 'blocked') rollbackTurn(result.blocked)
 */

import { context as otelContext } from '@opentelemetry/api';
import type { Attributes, Context as OtelContext, Tracer } from '@opentelemetry/api';
import { getTracer, SpanAttributes } from 'otel-hook';
import { Qwen3GuardHook } from './qwen3guard';
import type { Qwen3GuardConfig, SessionStartResult, StreamCheckResult } from './qwen3guard';

/** 结构化后端接口 —— Qwen3GuardHook 天然满足；测试/其他安全模型可替换实现 */
export interface GuardBackend {
  startSession(promptOrMessages: string | Array<{ role: string; content: string }>): Promise<SessionStartResult>;
  checkDelta(sessionId: string, delta: string): Promise<StreamCheckResult>;
  closeSession(sessionId: string): Promise<void>;
}

/** guard 事件：released = 过检可发布的文本；blocked = 拦截（blockedText = 被拦截的违规文本，未到达用户） */
export type GuardEvent =
  | { type: 'released'; text: string }
  | { type: 'blocked'; gate: string; reason: string; atChar: number; blockedText: string };

export interface InputGateResult {
  blocked: boolean;
  /** Unsafe 但未拦截（blockInput=false 消融模式：只打标，让输入抵达主模型） */
  unsafeFlagged: boolean;
  reason: string;
  label: string;
  category: string;
  confidence: number;
  latencyMs: number;
}

export interface StreamGuardConfig {
  /** 审核后端（默认由 hookConfig/endpoint 构造 Qwen3GuardHook） */
  backend?: GuardBackend;
  /** 便捷别名：直接传入已构造的 Qwen3GuardHook */
  hook?: Qwen3GuardHook;
  /** 便捷别名：由配置内部构造 Qwen3GuardHook */
  hookConfig?: Qwen3GuardConfig;
  /** 父 span context（所有 guard span 挂其下；缺省用调用时的 active context） */
  parentContext?: OtelContext;
  /** Langfuse session 归组 */
  sessionId?: string;
  /** Langfuse user 归因 */
  userId?: string;
  /** 门1 是否真拦截；false = 消融模式（只打标不拦截）。默认 true */
  blockInput?: boolean;
  /** 后端异常时行为：closed=拦截（默认，绝不假 Safe）；open=降级放行并打 degraded 标 */
  failMode?: 'closed' | 'open';
  /** 句子边界提前 flush 的最小字符数（默认 40） */
  minFlushChars?: number;
  /** 无标点长文（代码块等）强制 flush 的缓冲上限（默认 250） */
  maxBufferChars?: number;
  /** 自定义断句器（默认中英文标点+换行） */
  sentenceSplitter?: (s: string) => string[];
  /** span 名前缀（默认 hook.SafeGuard） */
  spanPrefix?: string;
  /** HOOK_NAME 前缀（默认 SafeGuard） */
  guardName?: string;
  /** span 上的 hook.priority（默认 15） */
  hookPriority?: number;
  /** 门1 span Input 携带的最近消息条数（默认 4） */
  historyWindow?: number;
  /** span IO 字段截断长度（默认 4000） */
  maxSpanTextChars?: number;
  /** 覆盖 tracer（测试/多实例场景） */
  tracer?: Tracer;
}

export interface StreamGuardStats {
  checks: number;
  serverMs: number;
  wallMs: number;
}

export interface BlockedInfo {
  gate: string;
  reason: string;
  atChar: number;
  blockedText: string;
}

/** runGuardedStream 的最终结果 */
export interface GuardedStreamOutcome {
  outcome: 'completed' | 'blocked';
  /** 已过检、已发布（onRelease 回调收到）的全部文本 */
  releasedText: string;
  publishedChars: number;
  blocked?: BlockedInfo;
  stats: StreamGuardStats;
}

const DEFAULT_MIN_FLUSH_CHARS = 40;
const DEFAULT_MAX_BUF_CHARS = 250;
const defaultSplitSentences = (s: string): string[] =>
  s.split(/(?<=[。！？.!?\n])/).filter(x => x.length > 0);

interface FlatMsg { role: string; content: string }

export class StreamGuard {
  private backend: GuardBackend;
  private parentContext?: OtelContext;
  private cfg: Required<Pick<StreamGuardConfig,
    'blockInput' | 'failMode' | 'minFlushChars' | 'maxBufferChars' |
    'spanPrefix' | 'guardName' | 'hookPriority' | 'historyWindow' | 'maxSpanTextChars'>> &
    { sessionId: string; userId: string; sentenceSplitter: (s: string) => string[] };
  private tracer: Tracer;

  private guardSessionId: string | null = null;
  private buf = '';
  private releasedChars = 0;
  private checkSeq = 0;

  /** 本轮全部检测的服务端 GPU 耗时（延迟归因） */
  public serverMsTotal = 0;
  /** 本轮全部检测的端到端 wall 耗时 */
  public wallMsTotal = 0;
  public checksCount = 0;

  constructor(config: StreamGuardConfig = {}) {
    const backend = config.backend ?? config.hook ??
      (config.hookConfig ? new Qwen3GuardHook(config.hookConfig) : null);
    if (!backend) {
      throw new Error('StreamGuard: 需要 backend / hook / hookConfig（或 endpoint）之一');
    }
    this.backend = backend;
    this.parentContext = config.parentContext;
    this.tracer = config.tracer ?? getTracer();
    this.cfg = {
      sessionId: config.sessionId ?? '',
      userId: config.userId ?? '',
      blockInput: config.blockInput !== false,
      failMode: config.failMode ?? 'closed',
      minFlushChars: config.minFlushChars ?? DEFAULT_MIN_FLUSH_CHARS,
      maxBufferChars: config.maxBufferChars ?? DEFAULT_MAX_BUF_CHARS,
      sentenceSplitter: config.sentenceSplitter ?? defaultSplitSentences,
      spanPrefix: config.spanPrefix ?? 'hook.SafeGuard',
      guardName: config.guardName ?? 'SafeGuard',
      hookPriority: config.hookPriority ?? 15,
      historyWindow: config.historyWindow ?? 4,
      maxSpanTextChars: config.maxSpanTextChars ?? 4000,
    };
  }

  get stats(): StreamGuardStats {
    return { checks: this.checksCount, serverMs: this.serverMsTotal, wallMs: this.wallMsTotal };
  }

  private ctx(): OtelContext {
    return this.parentContext ?? otelContext.active();
  }

  private startHookSpan(name: string, gate: string, extra: Attributes = {}) {
    return this.tracer.startSpan(name, {
      attributes: {
        [SpanAttributes.HOOK_NAME]: `${this.cfg.guardName}.${gate}`,
        [SpanAttributes.HOOK_POINT]: gate,
        [SpanAttributes.HOOK_PRIORITY]: this.cfg.hookPriority,
        'guard.gate': gate,
        'langfuse.observation.type': 'guardrail',
        ...(this.cfg.sessionId ? { 'langfuse.session.id': this.cfg.sessionId } : {}),
        ...(this.cfg.userId ? { 'langfuse.user.id': this.cfg.userId } : {}),
        ...extra,
      },
    }, this.ctx());
  }

  /** 门1：输入审核。history = 本轮完整消息历史（含刚 push 的用户输入） */
  async startTurn(history: Array<{ role: string; content: unknown }>): Promise<InputGateResult> {
    const flat: FlatMsg[] = history.map(m => ({
      role: String(m.role),
      content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
    }));
    const span = this.startHookSpan(`${this.cfg.spanPrefix}.input_gen`, 'input_gen', {
      'langfuse.observation.input': JSON.stringify(flat.slice(-this.cfg.historyWindow)).slice(0, this.cfg.maxSpanTextChars),
    });
    const t0 = Date.now();
    try {
      const s = await this.backend.startSession(flat);
      this.guardSessionId = s.sessionId;
      const wallMs = Date.now() - t0;
      this.serverMsTotal += s.latencyMs;
      this.wallMsTotal += wallMs;
      this.checksCount++;
      span.setAttributes({
        [SpanAttributes.HOOK_DURATION_MS]: wallMs,
        'guard.wall_ms': wallMs,
        'guard.server_latency_ms': s.latencyMs,
        'guard.prompt_label': s.promptVerdict.label,
        'guard.prompt_category': s.promptVerdict.category,
        'guard.prompt_confidence': s.promptVerdict.confidence,
        'guard.prompt_tokens': s.promptTokens,
        'guard.prompt_unsafe': s.promptUnsafe,
        'langfuse.observation.output': JSON.stringify({
          prompt_verdict: s.promptVerdict, prompt_unsafe: s.promptUnsafe,
          prompt_tokens: s.promptTokens, latency_ms: s.latencyMs,
        }),
      });
      const blockNow = s.promptUnsafe && this.cfg.blockInput;
      const out: InputGateResult = {
        blocked: blockNow,
        unsafeFlagged: s.promptUnsafe,
        reason: blockNow
          ? `input_gen: ${s.promptVerdict.category} (confidence: ${s.promptVerdict.confidence.toFixed(2)})`
          : '',
        label: s.promptVerdict.label,
        category: s.promptVerdict.category,
        confidence: s.promptVerdict.confidence,
        latencyMs: s.latencyMs,
      };
      if (blockNow) {
        span.setAttributes({
          [SpanAttributes.HOOK_ALLOWED]: false,
          [SpanAttributes.HOOK_BLOCKED]: true,
          [SpanAttributes.HOOK_REASON]: out.reason,
          'guard.intercept_gate': 'input_gen',
        });
        span.setStatus({ code: 2, message: out.reason });
        span.end();
        await this.close();
        return out;
      }
      span.setAttributes({
        [SpanAttributes.HOOK_ALLOWED]: true,
        [SpanAttributes.HOOK_BLOCKED]: false,
        ...(s.promptUnsafe ? {
          'guard.input_gate_disabled': true,
          'guard.input_flagged_only': true,
          'langfuse.observation.metadata.input_flagged_only': true,
        } : {}),
      });
      span.setStatus({ code: 1 });
      span.end();
      return out;
    } catch (e) {
      const msg = (e as Error).message.slice(0, 100);
      const failOpen = this.cfg.failMode === 'open';
      const reason = `guard_unavailable: ${msg}`;
      span.setAttributes({
        [SpanAttributes.HOOK_ALLOWED]: failOpen,
        [SpanAttributes.HOOK_BLOCKED]: !failOpen,
        ...(failOpen ? {} : { [SpanAttributes.HOOK_REASON]: reason }),
        'guard.degraded': true,
      });
      span.setStatus(failOpen ? { code: 1 } : { code: 2, message: reason });
      span.end();
      return failOpen
        ? { blocked: false, unsafeFlagged: false, reason: '', label: 'Error', category: 'guard_degraded', confidence: 0, latencyMs: Date.now() - t0 }
        : { blocked: true, unsafeFlagged: false, reason, label: 'Error', category: 'guard_unavailable', confidence: 1, latencyMs: Date.now() - t0 };
    }
  }

  /** 门2：喂入流式 delta，返回可发布文本 / 拦截事件（句子级 hold-back） */
  async push(delta: string): Promise<GuardEvent[]> {
    const events: GuardEvent[] = [];
    if (!this.guardSessionId) return [{ type: 'released', text: delta }];
    this.buf += delta;
    for (;;) {
      const sentences = this.cfg.sentenceSplitter(this.buf);
      const keep = sentences[sentences.length - 1] ?? '';
      if (sentences.length >= 2 && this.buf.length - keep.length >= this.cfg.minFlushChars) {
        const flushText = this.buf.slice(0, this.buf.length - keep.length);
        this.buf = keep;
        const ev = await this.check(flushText, 'output_stream');
        events.push(ev);
        if (ev.type === 'blocked') return events;
      } else if (this.buf.length >= this.cfg.maxBufferChars) {
        const flushText = this.buf;
        this.buf = '';
        const ev = await this.check(flushText, 'output_stream');
        events.push(ev);
        if (ev.type === 'blocked') return events;
      } else {
        break;
      }
    }
    return events;
  }

  /** 门3：流自然结束后，剩余 hold-back 文本终检 */
  async finish(): Promise<GuardEvent[]> {
    if (!this.buf || !this.guardSessionId) return [];
    const flushText = this.buf;
    this.buf = '';
    return [await this.check(flushText, 'output_gen')];
  }

  private async check(text: string, gate: string): Promise<GuardEvent> {
    this.checkSeq++;
    const seq = this.checkSeq;
    const span = this.startHookSpan(`${this.cfg.spanPrefix}.${gate}#${seq}`, gate, {
      'guard.check_seq': seq,
      'guard.session_id': this.guardSessionId ?? '',
      'stream.chars_checked': this.releasedChars + text.length,
      'langfuse.observation.input': JSON.stringify({ gate, seq, checked_text: text }).slice(0, this.cfg.maxSpanTextChars),
    });
    const t0 = Date.now();
    try {
      const chk = await this.backend.checkDelta(this.guardSessionId!, text);
      const wallMs = Date.now() - t0;
      this.serverMsTotal += chk.latencyMs;
      this.wallMsTotal += wallMs;
      this.checksCount++;
      span.setAttributes({
        [SpanAttributes.HOOK_DURATION_MS]: wallMs,
        'guard.wall_ms': wallMs,
        'guard.server_latency_ms': chk.latencyMs,
        'guard.new_tokens': chk.newTokens,
        'guard.delta_chars': text.length,
        'guard.worst_label': chk.verdict?.label ?? '',
        'guard.worst_category': chk.verdict?.category ?? '',
        'guard.worst_confidence': chk.verdict?.confidence ?? 0,
        'langfuse.observation.output': JSON.stringify({
          should_abort: chk.shouldAbort, flagged: chk.flagged, flag_reason: chk.flagReason ?? null,
          worst: chk.verdict ?? null, last: chk.last ?? null,
          new_tokens: chk.newTokens, server_latency_ms: chk.latencyMs,
        }),
      });
      if (chk.shouldAbort) {
        const reason = chk.reason || `guard: ${chk.verdict?.category ?? ''} (confidence: ${chk.verdict?.confidence?.toFixed(2) ?? '?'})`;
        span.setAttributes({
          [SpanAttributes.HOOK_ALLOWED]: false,
          [SpanAttributes.HOOK_BLOCKED]: true,
          [SpanAttributes.HOOK_REASON]: reason,
          'guard.intercept_gate': gate,
          'guard.intercept_at_char': this.releasedChars + text.length,
        });
        span.setStatus({ code: 2, message: reason });
        span.end();
        return { type: 'blocked', gate, reason, atChar: this.releasedChars + text.length, blockedText: text };
      }
      span.setAttributes({
        [SpanAttributes.HOOK_ALLOWED]: true,
        [SpanAttributes.HOOK_BLOCKED]: false,
        ...(chk.flagged ? { 'guard.flagged': true, 'guard.flag_reason': chk.flagReason || '' } : {}),
      });
      span.setStatus({ code: 1 });
      span.end();
      this.releasedChars += text.length;
      return { type: 'released', text };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 100);
      const failOpen = this.cfg.failMode === 'open';
      if (failOpen) {
        span.setAttributes({
          [SpanAttributes.HOOK_ALLOWED]: true, [SpanAttributes.HOOK_BLOCKED]: false,
          'guard.degraded': true, 'guard.degraded_reason': msg,
        });
        span.setStatus({ code: 1 });
        span.end();
        this.releasedChars += text.length;
        return { type: 'released', text };
      }
      const reason = `guard_error: ${msg}`;
      span.setAttributes({ [SpanAttributes.HOOK_ALLOWED]: false, [SpanAttributes.HOOK_BLOCKED]: true, [SpanAttributes.HOOK_REASON]: reason });
      span.setStatus({ code: 2, message: reason });
      span.end();
      return { type: 'blocked', gate, reason, atChar: this.releasedChars + text.length, blockedText: text };
    }
  }

  /** 关闭 guard session（幂等） */
  async close(): Promise<void> {
    if (!this.guardSessionId) return;
    const id = this.guardSessionId;
    this.guardSessionId = null;
    try { await this.backend.closeSession(id); } catch { /* best-effort */ }
  }
}

/**
 * 高层包装器（agent 无关）：把任意 delta 流接入门2+门3。
 * - source 为函数时收到内部 AbortSignal —— 拦截即 abort 上游 LLM 流（hold-back 零暴露语义）
 * - 过检文本实时回调 onRelease（增量渲染）；拦截后不再回调
 * - 自然结束后自动执行门3 终检；无论结局都 close guard session
 */
export async function runGuardedStream(
  source: AsyncIterable<string> | ((signal: AbortSignal) => AsyncIterable<string>),
  guard: StreamGuard,
  opts: { onRelease?: (text: string) => void | Promise<void> } = {},
): Promise<GuardedStreamOutcome> {
  const ac = new AbortController();
  const stream = typeof source === 'function' ? source(ac.signal) : source;
  let releasedText = '';
  let blocked: BlockedInfo | null = null;

  const emit = async (evs: GuardEvent[]): Promise<boolean /*blocked*/> => {
    for (const ev of evs) {
      if (ev.type === 'released') {
        releasedText += ev.text;
        if (ev.text && opts.onRelease) await opts.onRelease(ev.text);
      } else {
        blocked = { gate: ev.gate, reason: ev.reason, atChar: ev.atChar, blockedText: ev.blockedText };
        return true;
      }
    }
    return false;
  };

  try {
    for await (const delta of stream) {
      if (await emit(await guard.push(delta))) { ac.abort(); break; }
    }
    if (!blocked) {
      await emit(await guard.finish());
    }
  } finally {
    await guard.close();
  }
  return {
    outcome: blocked ? 'blocked' : 'completed',
    releasedText,
    publishedChars: releasedText.length,
    blocked: blocked ?? undefined,
    stats: guard.stats,
  };
}

/** 探测 guard server 是否可用（启动预检；不可用可降级为无守卫运行并告警） */
export async function guardServerAlive(endpoint: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const resp = await fetch(`${endpoint}/safety/check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ input: 'ping', role: 'user' }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

export interface CreateStreamGuardOptions extends StreamGuardConfig {
  /** 便捷入口：直接给 endpoint（内部构造 Qwen3GuardHook, provider=python, mode=stream） */
  endpoint?: string;
  apiKey?: string;
  threshold?: number;
  timeoutMs?: number;
}

/** 显式配置构造：endpoint/hookConfig/backend 三选一 */
export function createStreamGuard(opts: CreateStreamGuardOptions = {}): StreamGuard {
  const { endpoint, apiKey, threshold, timeoutMs, ...rest } = opts;
  if (!rest.backend && !rest.hook && !rest.hookConfig && endpoint) {
    rest.hookConfig = {
      endpoint,
      apiKey: apiKey ?? 'EMPTY',
      mode: 'stream',
      provider: 'python',
      threshold: threshold ?? 0.7,
      timeout: timeoutMs ?? 30000,
    };
  }
  return new StreamGuard(rest);
}

/**
 * 环境变量构造（可配置调用项）：
 *   SAFE_GUARD=0            → 返回 null（对照组/关闭守卫）
 *   QWEN3GUARD_ENDPOINT     → 默认 http://localhost:8000
 *   GUARD_THRESHOLD         → 默认 0.7
 *   GUARD_TIMEOUT_MS        → 默认 30000
 *   GUARD_FAIL_MODE=open    → 后端异常降级放行（默认 closed）
 *   NO_INPUT_BLOCK=1        → 消融模式：门1 只打标不拦截
 *   GUARD_SESSION_ID / GUARD_USER_ID → Langfuse 归组归因
 *   GUARD_MIN_FLUSH_CHARS / GUARD_MAX_BUF_CHARS → hold-back 分块参数
 */
export function streamGuardFromEnv(env: NodeJS.ProcessEnv = process.env, overrides: CreateStreamGuardOptions = {}): StreamGuard | null {
  if (env.SAFE_GUARD === '0') return null;
  return createStreamGuard({
    endpoint: env.QWEN3GUARD_ENDPOINT ?? 'http://localhost:8000',
    threshold: env.GUARD_THRESHOLD ? Number(env.GUARD_THRESHOLD) : undefined,
    timeoutMs: env.GUARD_TIMEOUT_MS ? Number(env.GUARD_TIMEOUT_MS) : undefined,
    failMode: env.GUARD_FAIL_MODE === 'open' ? 'open' : 'closed',
    blockInput: env.NO_INPUT_BLOCK !== '1',
    sessionId: env.GUARD_SESSION_ID,
    userId: env.GUARD_USER_ID ?? env.USER,
    minFlushChars: env.GUARD_MIN_FLUSH_CHARS ? Number(env.GUARD_MIN_FLUSH_CHARS) : undefined,
    maxBufferChars: env.GUARD_MAX_BUF_CHARS ? Number(env.GUARD_MAX_BUF_CHARS) : undefined,
    ...overrides,
  });
}
