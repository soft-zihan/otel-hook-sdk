import { Hook, HookContext } from 'otel-hook';

export class DangerousCommandHook {
  private patterns: RegExp[];
  public priority: number;
  public name: string;

  constructor(patterns?: RegExp[], priority: number = 10) {
    this.patterns = patterns || [
      /rm\s+-rf/i,
      /DROP\s+TABLE/i,
      /DELETE\s+FROM/i,
      /\/etc\/passwd/i,
      /mkfs/i,
      /dd\s+if=/i,
    ];
    this.priority = priority;
    this.name = 'dangerous_command';
  }

  call(ctx: HookContext) {
    const args = String(ctx.data['tool.args'] || '');
    for (const pattern of this.patterns) {
      if (pattern.test(args)) {
        return { allowed: false, reason: `dangerous operation detected: ${pattern}` };
      }
    }
    return { allowed: true };
  }
}
