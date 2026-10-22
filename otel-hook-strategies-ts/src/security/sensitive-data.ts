import { HookContext, HookResult } from 'otel-hook';

export class SensitiveDataHook {
  private sensitiveKeys: Set<string>;
  public priority: number;
  public name: string;

  constructor(sensitiveKeys?: string[], priority: number = 10) {
    this.sensitiveKeys = new Set(sensitiveKeys || [
      'password',
      'secret',
      'token',
      'api_key',
      'private_key',
    ]);
    this.priority = priority;
    this.name = 'sensitive_data';
  }

  call(ctx: HookContext): HookResult {
    for (const key of Object.keys(ctx.data)) {
      if (this.sensitiveKeys.has(key.toLowerCase())) {
        return { allowed: false, reason: `sensitive key detected: ${key}` };
      }
    }
    return { allowed: true };
  }
}
