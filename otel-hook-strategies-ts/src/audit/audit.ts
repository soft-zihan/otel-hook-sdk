import { HookContext, HookResult } from 'otel-hook';

export class AuditHook {
  public priority: number;
  public name: string;

  constructor(priority: number = 1000) {
    this.priority = priority;
    this.name = 'audit';
  }

  call(ctx: HookContext): HookResult {
    console.log(`[AUDIT] session=${ctx.data.sessionId || 'unknown'} ts=${new Date().toISOString()}`);
    return { allowed: true };
  }
}
