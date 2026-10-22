import {
  HookContext,
  HookResult,
  HookConfig,
  Hook,
  HookWrapper,
  createHookWrapper,
  HookChain,
  HookRegistry,
  registerHook,
  runHooks,
} from '../src/hooks';

describe('HookContext', () => {
  it('should create basic context', () => {
    const ctx: HookContext = {
      data: { action: 'test' },
    };
    expect(ctx.data).toEqual({ action: 'test' });
  });

  it('should create context with all fields', () => {
    const ctx: HookContext = {
      data: {
        model: 'gpt-4',
        session_id: 'session_123',
        user_id: 'user_456',
      },
    };
    expect(ctx.data.model).toBe('gpt-4');
    expect(ctx.data.session_id).toBe('session_123');
    expect(ctx.data.user_id).toBe('user_456');
  });
});

describe('HookResult', () => {
  it('should create allow result', () => {
    const result: HookResult = { allowed: true };
    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
    expect(result.data).toBeUndefined();
  });

  it('should create deny result', () => {
    const result: HookResult = { allowed: false, reason: 'test reason' };
    expect(result.allowed).toBe(false);
    expect(result.reason).toBe('test reason');
  });

  it('should create allow result with data', () => {
    const result: HookResult = { allowed: true, data: { key: 'value' } };
    expect(result.allowed).toBe(true);
    expect(result.data).toEqual({ key: 'value' });
  });
});

describe('HookConfig', () => {
  it('should have default values', () => {
    const config: Required<HookConfig> = {
      timeoutMs: 1000,
      enabled: true,
    };
    expect(config.timeoutMs).toBe(1000);
    expect(config.enabled).toBe(true);
  });
});

describe('HookWrapper', () => {
  it('should execute hook', async () => {
    const myHook: Hook = (ctx) => ({ allowed: true });
    const wrapper = createHookWrapper(myHook, 'test_hook', 10);
    const ctx: HookContext = { data: {} };
    const result = wrapper.hook(ctx);
    expect(result.allowed).toBe(true);
  });

  it('should respect priority', () => {
    const myHook: Hook = (ctx) => ({ allowed: true });
    const wrapper = createHookWrapper(myHook, 'test_hook', 5);
    expect(wrapper.priority).toBe(5);
  });

  it('should respect enabled flag', async () => {
    const myHook: Hook = (ctx) => ({ allowed: false, reason: 'should not run' });
    const wrapper = createHookWrapper(myHook, 'test_hook', 50, { enabled: false });
    expect(wrapper.config.enabled).toBe(false);
  });

  it('should handle error gracefully', async () => {
    const badHook: Hook = (ctx) => {
      throw new Error('test error');
    };
    const wrapper = createHookWrapper(badHook, 'test_hook', 50);
    const ctx: HookContext = { data: {} };

    const chain = new HookChain([wrapper]);
    const results = await chain.run(ctx);
    expect(results.length).toBe(1);
    expect(results[0].allowed).toBe(false);
    expect(results[0].reason).toBe('test error');
  });
});

describe('HookChain', () => {
  it('should sort hooks by priority', () => {
    const hook1: Hook = (ctx) => ({ allowed: true });
    const hook2: Hook = (ctx) => ({ allowed: true });
    const hook3: Hook = (ctx) => ({ allowed: true });

    const wrappers = [
      createHookWrapper(hook3, 'hook3', 100),
      createHookWrapper(hook1, 'hook1', 10),
      createHookWrapper(hook2, 'hook2', 50),
    ];
    const chain = new HookChain(wrappers);

    const priorities = (chain as any).hooks.map((w: HookWrapper) => w.priority);
    expect(priorities).toEqual([10, 50, 100]);
  });

  it('should run all hooks and return results array', async () => {
    const executed: string[] = [];

    const hook1: Hook = (ctx) => {
      executed.push('hook1');
      return { allowed: false, reason: 'blocked' };
    };
    const hook2: Hook = (ctx) => {
      executed.push('hook2');
      return { allowed: true };
    };

    const wrappers = [
      createHookWrapper(hook1, 'hook1', 10),
      createHookWrapper(hook2, 'hook2', 20),
    ];
    const chain = new HookChain(wrappers);

    const ctx: HookContext = { data: {} };
    const results = await chain.run(ctx);

    expect(results.length).toBe(2);
    expect(results[0].allowed).toBe(false);
    expect(results[0].reason).toBe('blocked');
    expect(results[1].allowed).toBe(true);
    expect(executed).toEqual(['hook1', 'hook2']);
  });

  it('should collect data modifications', async () => {
    const hook1: Hook = (ctx) => ({ allowed: true, data: { key1: 'value1' } });
    const hook2: Hook = (ctx) => ({ allowed: true, data: { key2: 'value2' } });

    const wrappers = [
      createHookWrapper(hook1, 'hook1', 10),
      createHookWrapper(hook2, 'hook2', 20),
    ];
    const chain = new HookChain(wrappers);

    const ctx: HookContext = { data: {} };
    const results = await chain.run(ctx);

    expect(results.length).toBe(2);
    expect(results[0].data).toEqual({ key1: 'value1' });
    expect(results[1].data).toEqual({ key2: 'value2' });
  });
});

describe('HookRegistry', () => {
  it('should register and run hook', async () => {
    const registry = new HookRegistry();

    const myHook: Hook = (ctx) => {
      if (ctx.data.action === 'dangerous command') {
        return { allowed: false, reason: 'dangerous action' };
      }
      return { allowed: true };
    };

    registry.register('tool_call', myHook, 'security_check', 10);

    const ctx: HookContext = {
      data: { action: 'dangerous command' },
    };
    const results = await registry.run('tool_call', ctx);
    expect(results.length).toBe(1);
    expect(results[0].allowed).toBe(false);
  });

  it('should return empty array for unregistered event', async () => {
    const registry = new HookRegistry();

    const ctx: HookContext = { data: {} };
    const results = await registry.run('unknown_event', ctx);
    expect(results).toEqual([]);
  });
});

describe('Global functions', () => {
  it('should register and run global hook', async () => {
    const myHook: Hook = (ctx) => ({ allowed: false, reason: 'blocked' });

    registerHook('test_event', myHook, 'test_hook', 10);

    const ctx: HookContext = { data: {} };
    const results = await runHooks('test_event', ctx);
    expect(results.length).toBe(1);
    expect(results[0].allowed).toBe(false);
  });
});
