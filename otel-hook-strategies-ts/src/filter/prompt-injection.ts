import { HookContext, HookResult } from 'otel-hook';

export class PromptInjectionHook {
  private patterns: RegExp[];
  public priority: number;
  public name: string;

  constructor(patterns?: RegExp[], priority: number = 25) {
    this.patterns = patterns || [
      /ignore\s+previous\s+instructions/i,
      /you\s+are\s+now\s+a/i,
      /system:/i,
      /jailbreak/i,
      /DAN\s+mode/i,
    ];
    this.priority = priority;
    this.name = 'prompt_injection';
  }

  call(ctx: HookContext): HookResult {
    const input = ctx.data.rawInput || '';
    for (const pattern of this.patterns) {
      if (pattern.test(input)) {
        return { allowed: false, reason: `prompt injection detected: ${pattern}` };
      }
    }
    return { allowed: true };
  }
}
