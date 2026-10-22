import { HookContext, HookResult } from 'otel-hook';

export class WordFilterHook {
  private sensitiveWords: string[];
  public priority: number;
  public name: string;

  constructor(sensitiveWords?: string[], priority: number = 15) {
    this.sensitiveWords = sensitiveWords || [
      '暴力',
      '色情',
      '赌博',
      '毒品',
      '枪支',
      '爆炸物',
    ];
    this.priority = priority;
    this.name = 'word_filter';
  }

  call(ctx: HookContext): HookResult {
    const input = ctx.data.rawInput || '';
    for (const word of this.sensitiveWords) {
      if (input.includes(word)) {
        return { allowed: false, reason: `sensitive word detected: '${word}'` };
      }
    }
    return { allowed: true };
  }
}
