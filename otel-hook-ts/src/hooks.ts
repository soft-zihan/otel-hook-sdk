/**
 * Hook mechanism for otel-hook SDK.
 *
 * The SDK provides the mechanism only:
 * - Run hooks in priority order per event
 * - Create spans for each hook execution (timing, errors)
 * - Collect and return results
 * - Mark trace for export when violation detected
 *
 * The SDK does NOT prescribe what hook results mean.
 * Each agent interprets results however it needs to.
 */

import { trace, Span, SpanStatusCode } from '@opentelemetry/api';
import { markTraceForExport } from './exporter.js';

export interface HookContext {
  data: Record<string, any>;
}

export interface HookResult {
  allowed: boolean;
  reason?: string;
  data?: Record<string, any>;
}

export interface HookConfig {
  timeoutMs?: number;
  enabled?: boolean;
}

export type Hook = (context: HookContext) => HookResult | Promise<HookResult>;

export interface HookWrapper {
  hook: Hook;
  name: string;
  priority: number;
  config: Required<HookConfig>;
}

export function createHookWrapper(
  hook: Hook,
  name: string,
  priority: number = 50,
  config?: HookConfig
): HookWrapper {
  return {
    hook,
    name,
    priority,
    config: {
      timeoutMs: config?.timeoutMs ?? 1000,
      enabled: config?.enabled ?? true,
    },
  };
}

export class HookChain {
  private hooks: HookWrapper[];

  constructor(hooks: HookWrapper[]) {
    this.hooks = hooks.sort((a, b) => a.priority - b.priority);
  }

  async run(context: HookContext): Promise<HookResult[]> {
    const results: HookResult[] = [];
    const tracer = trace.getTracer('otel-hook');

    for (const wrapper of this.hooks) {
      if (!wrapper.config.enabled) {
        continue;
      }

      const startTime = Date.now();
      const hookSpan = tracer.startSpan(`hook.${wrapper.name}`, {
        attributes: {
          'hook.name': wrapper.name,
          'hook.priority': wrapper.priority,
        },
      });

      const traceId = hookSpan.spanContext().traceId;

      let result: HookResult | null = null;
      let error: Error | null = null;
      try {
        result = await wrapper.hook(context);
      } catch (e) {
        error = e as Error;
      }

      const durationMs = Date.now() - startTime;
      hookSpan.setAttributes({
        'hook.duration_ms': durationMs,
        'hook.error': error ? error.message : '',
      });

      if (error) {
        hookSpan.setAttributes({
          'hook.allowed': false,
          'hook.blocked': true,
          'hook.reason': error.message,
        });
        hookSpan.setStatus({ code: SpanStatusCode.ERROR, message: error.message });
        results.push({ allowed: false, reason: error.message });
        markTraceForExport(traceId, 'hook_error');
      } else if (result) {
        hookSpan.setAttributes({
          'hook.allowed': result.allowed,
          'hook.blocked': !result.allowed,
          'hook.reason': result.reason || '',
        });
        if (result.data) {
          hookSpan.setAttribute('hook.data', JSON.stringify(result.data));
        }
        
        if (!result.allowed) {
          hookSpan.setStatus({ code: SpanStatusCode.ERROR, message: result.reason || 'blocked' });
          markTraceForExport(traceId, wrapper.name);
        } else {
          hookSpan.setStatus({ code: SpanStatusCode.OK });
        }
        results.push(result);
      }

      hookSpan.end();
    }

    return results;
  }
}

export class HookRegistry {
  private hooks: Map<string, HookChain> = new Map();

  register(
    event: string,
    hook: Hook,
    name: string,
    priority: number = 50,
    config?: HookConfig
  ): void {
    const wrapper = createHookWrapper(hook, name, priority, config);

    let chain = this.hooks.get(event);
    if (!chain) {
      chain = new HookChain([wrapper]);
      this.hooks.set(event, chain);
    } else {
      const existingHooks = (chain as any).hooks as HookWrapper[];
      chain = new HookChain([...existingHooks, wrapper]);
      this.hooks.set(event, chain);
    }
  }

  get(event: string): HookChain | undefined {
    return this.hooks.get(event);
  }

  async run(event: string, context: HookContext): Promise<HookResult[]> {
    const chain = this.get(event);
    if (chain) {
      return chain.run(context);
    }
    return [];
  }
}

const globalRegistry = new HookRegistry();

export function registerHook(
  event: string,
  hook: Hook,
  name: string,
  priority: number = 50,
  config?: HookConfig
): void {
  globalRegistry.register(event, hook, name, priority, config);
}

export async function runHooks(event: string, context: HookContext): Promise<HookResult[]> {
  return globalRegistry.run(event, context);
}
