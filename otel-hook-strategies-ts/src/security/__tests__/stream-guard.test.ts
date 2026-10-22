import { trace } from '@opentelemetry/api';
import {
  StreamGuard,
  runGuardedStream,
  guardServerAlive,
  createStreamGuard,
  streamGuardFromEnv,
  GuardBackend,
} from '../stream-guard';
import type { SessionStartResult, StreamCheckResult } from '../qwen3guard';

// ---------- mock 后端 ----------

interface MockScript {
  start?: Partial<SessionStartResult> | Error;
  checks?: Array<Partial<StreamCheckResult> | Error>;
}

function mockBackend(script: MockScript = {}) {
  const closed: string[] = [];
  let checkIdx = 0;
  const backend: GuardBackend = {
    async startSession(): Promise<SessionStartResult> {
      const s = script.start;
      if (s instanceof Error) throw s;
      return {
        sessionId: 'sess-1',
        promptVerdict: { label: 'Safe', category: '', confidence: 1 },
        promptUnsafe: false,
        promptTokens: 5,
        latencyMs: 1,
        ...(s ?? {}),
      } as SessionStartResult;
    },
    async checkDelta(_sid: string, delta: string): Promise<StreamCheckResult> {
      const c = script.checks?.[checkIdx++];
      if (c instanceof Error) throw c;
      return {
        shouldAbort: false,
        flagged: false,
        newTokens: delta.length,
        latencyMs: 1,
        ...(c ?? {}),
      } as StreamCheckResult;
    },
    async closeSession(sid: string) { closed.push(sid); },
  };
  return { backend, closed };
}

const noopTracer = trace.getTracer('stream-guard-test');

function makeGuard(script: MockScript = {}, extra: object = {}) {
  const { backend, closed } = mockBackend(script);
  const guard = new StreamGuard({
    backend,
    tracer: noopTracer,
    minFlushChars: 5,
    sessionId: 'lf-session',
    userId: 'tester',
    ...extra,
  });
  return { guard, closed };
}

const unsafeStart: Partial<SessionStartResult> = {
  promptVerdict: { label: 'Unsafe', category: 'Jailbreak', confidence: 0.94 },
  promptUnsafe: true,
};

const abortCheck: Partial<StreamCheckResult> = {
  shouldAbort: true,
  flagged: true,
  flagReason: 'unsafe',
  reason: 'Qwen3Guard: Non-violent Illegal Acts (confidence: 0.82)',
  verdict: { label: 'Unsafe', category: 'Non-violent Illegal Acts', confidence: 0.82 },
};

const history = [{ role: 'user', content: 'hello' }];

// ---------- 门1 input_gen ----------

describe('gate 1: input_gen', () => {
  it('blocks unsafe input and closes guard session (main model zero-call)', async () => {
    const { guard, closed } = makeGuard({ start: unsafeStart });
    const r = await guard.startTurn(history);
    expect(r.blocked).toBe(true);
    expect(r.unsafeFlagged).toBe(true);
    expect(r.reason).toContain('Jailbreak');
    expect(closed).toEqual(['sess-1']);
  });

  it('ablation mode (blockInput=false): flags but does not block', async () => {
    const { guard, closed } = makeGuard({ start: unsafeStart }, { blockInput: false });
    const r = await guard.startTurn(history);
    expect(r.blocked).toBe(false);
    expect(r.unsafeFlagged).toBe(true);
    expect(closed).toEqual([]);
  });

  it('passes safe input and keeps session open for output gates', async () => {
    const { guard } = makeGuard();
    const r = await guard.startTurn(history);
    expect(r.blocked).toBe(false);
    expect(r.unsafeFlagged).toBe(false);
  });

  it('fail-closed: backend error on startTurn → blocked', async () => {
    const { guard } = makeGuard({ start: new Error('ECONNREFUSED') });
    const r = await guard.startTurn(history);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain('guard_unavailable');
  });

  it('fail-open: backend error on startTurn → allowed (degraded)', async () => {
    const { guard } = makeGuard({ start: new Error('ECONNREFUSED') }, { failMode: 'open' });
    const r = await guard.startTurn(history);
    expect(r.blocked).toBe(false);
    expect(r.category).toBe('guard_degraded');
  });
});

// ---------- 门2 output_stream (hold-back) ----------

describe('gate 2: output_stream hold-back', () => {
  it('passes deltas through when startTurn was never called (guard inactive)', async () => {
    const { guard } = makeGuard();
    const evs = await guard.push('anything at all');
    expect(evs).toEqual([{ type: 'released', text: 'anything at all' }]);
  });

  it('holds back a single short sentence (nothing published yet)', async () => {
    const { guard } = makeGuard();
    await guard.startTurn(history);
    const evs = await guard.push('一二三。');
    expect(evs).toEqual([]);   // 扣住在缓冲区
  });

  it('flushes completed sentences past minFlushChars, keeps last in buffer', async () => {
    const { guard } = makeGuard();
    await guard.startTurn(history);
    const evs = await guard.push('一二三四五六。七八九十。');
    expect(evs).toEqual([{ type: 'released', text: '一二三四五六。' }]);
    const fin = await guard.finish();   // 门3 发布剩余
    expect(fin).toEqual([{ type: 'released', text: '七八九十。' }]);
  });

  it('force-flushes long text without sentence boundaries (code blocks) at maxBufferChars', async () => {
    const { guard } = makeGuard({}, { maxBufferChars: 10 });
    await guard.startTurn(history);
    const evs = await guard.push('abcdefghijklmnopqrstuvwxyz');   // 无标点 26 字符
    expect(evs).toEqual([{ type: 'released', text: 'abcdefghijklmnopqrstuvwxyz' }]);
  });

  it('blocked mid-stream: event carries gate/atChar/blockedText, zero exposure of blocked text', async () => {
    const { guard } = makeGuard({ checks: [abortCheck] });
    await guard.startTurn(history);
    const evs = await guard.push('一二三四五六。七八九十。');
    expect(evs).toHaveLength(1);
    expect(evs[0]).toMatchObject({
      type: 'blocked', gate: 'output_stream', atChar: 7, blockedText: '一二三四五六。',
    });
  });

  it('fail-closed: checkDelta error → blocked(guard_error)', async () => {
    const { guard } = makeGuard({ checks: [new Error('timeout')] });
    await guard.startTurn(history);
    const evs = await guard.push('一二三四五六。七八九十。');
    expect(evs[0]).toMatchObject({ type: 'blocked', reason: expect.stringContaining('guard_error') });
  });

  it('fail-open: checkDelta error → released (degraded)', async () => {
    const { guard } = makeGuard({ checks: [new Error('timeout')] }, { failMode: 'open' });
    await guard.startTurn(history);
    const evs = await guard.push('一二三四五六。七八九十。');
    expect(evs[0]).toMatchObject({ type: 'released', text: '一二三四五六。' });
  });

  it('custom sentenceSplitter is honored', async () => {
    const { guard } = makeGuard({}, { sentenceSplitter: (s: string) => s.split(/(?<=;;)/).filter(Boolean) });
    await guard.startTurn(history);
    const evs = await guard.push('aaaa;;bbbb;;');
    expect(evs).toEqual([{ type: 'released', text: 'aaaa;;' }]);
  });

  it('accumulates stats (checks / serverMs)', async () => {
    const { guard } = makeGuard();
    await guard.startTurn(history);
    await guard.push('一二三四五六。七八九十。');
    const s = guard.stats;
    expect(s.checks).toBe(2);           // startTurn + 1 次 output_stream
    expect(s.serverMs).toBeGreaterThanOrEqual(2);
  });
});

// ---------- 门3 output_gen ----------

describe('gate 3: output_gen', () => {
  it('finish() checks remaining hold-back text and can block publication', async () => {
    const { guard } = makeGuard({ checks: [abortCheck] });
    await guard.startTurn(history);
    await guard.push('短文本无句号');          // 留在缓冲区
    const fin = await guard.finish();
    expect(fin[0]).toMatchObject({ type: 'blocked', gate: 'output_gen', blockedText: '短文本无句号' });
  });

  it('finish() is a no-op with empty buffer or inactive guard', async () => {
    const { guard } = makeGuard();
    expect(await guard.finish()).toEqual([]);
    await guard.startTurn(history);
    expect(await guard.finish()).toEqual([]);
  });
});

// ---------- runGuardedStream 高层包装器 ----------

describe('runGuardedStream', () => {
  it('releases checked text incrementally and completes with stats', async () => {
    const { guard, closed } = makeGuard();
    await guard.startTurn(history);
    const released: string[] = [];
    async function* src() { yield '一二三四五六。'; yield '七八九十。'; yield '收尾句。'; }
    const r = await runGuardedStream(src(), guard, { onRelease: t => { released.push(t); } });
    expect(r.outcome).toBe('completed');
    expect(r.releasedText).toBe('一二三四五六。七八九十。收尾句。');
    expect(released.join('')).toBe(r.releasedText);
    expect(r.publishedChars).toBe(r.releasedText.length);
    expect(closed).toEqual(['sess-1']);   // session 自动关闭
  });

  it('blocks mid-stream: aborts upstream signal, published text stays safe prefix', async () => {
    const { guard, closed } = makeGuard({ checks: [{}, abortCheck] });
    await guard.startTurn(history);
    let capturedSignal: AbortSignal | null = null;
    const released: string[] = [];
    async function* src(signal: AbortSignal) {
      capturedSignal = signal;
      yield '一二三四五六。';
      yield '七八九十。';
      yield '永远不该到达。';
    }
    const r = await runGuardedStream(src, guard, { onRelease: t => { released.push(t); } });
    expect(r.outcome).toBe('blocked');
    expect(r.releasedText).toBe('一二三四五六。');
    expect(r.blocked).toMatchObject({ gate: 'output_stream', blockedText: '七八九十。' });
    expect(capturedSignal!.aborted).toBe(true);
    expect(closed).toEqual(['sess-1']);
  });

  it('propagates source errors but still closes the session', async () => {
    const { guard, closed } = makeGuard();
    await guard.startTurn(history);
    async function* src(): AsyncGenerator<string> { yield '一二三四五六。'; throw new Error('llm down'); }
    await expect(runGuardedStream(src(), guard)).rejects.toThrow('llm down');
    expect(closed).toEqual(['sess-1']);
  });
});

// ---------- 工厂与探测 ----------

describe('factories & probing', () => {
  it('createStreamGuard builds a Qwen3GuardHook from endpoint shorthand', () => {
    const g = createStreamGuard({ endpoint: 'http://localhost:1', sessionId: 's', tracer: noopTracer });
    expect(g).toBeInstanceOf(StreamGuard);
  });

  it('createStreamGuard without any backend throws', () => {
    expect(() => createStreamGuard({ tracer: noopTracer })).toThrow(/backend/);
  });

  it('streamGuardFromEnv: SAFE_GUARD=0 → null (control group)', () => {
    expect(streamGuardFromEnv({ SAFE_GUARD: '0' } as NodeJS.ProcessEnv)).toBeNull();
  });

  it('streamGuardFromEnv: NO_INPUT_BLOCK=1 → ablation (flag only)', async () => {
    const { backend } = mockBackend({ start: unsafeStart });
    const g = streamGuardFromEnv(
      { NO_INPUT_BLOCK: '1' } as NodeJS.ProcessEnv,
      { backend, tracer: noopTracer },
    )!;
    const r = await g.startTurn(history);
    expect(r.blocked).toBe(false);
    expect(r.unsafeFlagged).toBe(true);
  });

  it('streamGuardFromEnv: GUARD_FAIL_MODE=open is wired through', async () => {
    const { backend } = mockBackend({ start: new Error('down') });
    const g = streamGuardFromEnv(
      { GUARD_FAIL_MODE: 'open' } as NodeJS.ProcessEnv,
      { backend, tracer: noopTracer },
    )!;
    const r = await g.startTurn(history);
    expect(r.blocked).toBe(false);
  });

  it('guardServerAlive returns false for unreachable endpoint', async () => {
    expect(await guardServerAlive('http://127.0.0.1:59999', 500)).toBe(false);
  });
});
