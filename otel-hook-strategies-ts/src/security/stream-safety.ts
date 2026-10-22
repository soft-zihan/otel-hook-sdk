import { HookContext, HookResult } from 'otel-hook';

/**
 * Stream Safety Checker Hook
 * 
 * This hook is designed to work with streaming model outputs.
 * It accumulates chunks and checks them periodically against safety rules.
 * 
 * Usage:
 * 1. Register this hook for model_call events
 * 2. In your agent loop, call checkChunk() for each streaming chunk
 * 3. If shouldAbort is true, stop the stream and record the violation
 */

export interface StreamSafetyConfig {
  checkInterval?: number;  // Check every N characters
  maxChunkSize?: number;   // Maximum chunk size to check
  patterns?: RegExp[];     // Additional patterns to check
}

export class StreamSafetyHook {
  private config: Required<StreamSafetyConfig>;
  private buffer: string = '';
  private lastCheckIndex: number = 0;
  public priority: number;
  public name: string;

  constructor(config: StreamSafetyConfig = {}, priority: number = 5) {
    this.config = {
      checkInterval: config.checkInterval || 100,
      maxChunkSize: config.maxChunkSize || 500,
      patterns: config.patterns || [
        /rm\s+-rf/i,
        /DROP\s+TABLE/i,
        /DELETE\s+FROM/i,
        /\/etc\/passwd/i,
        /ignore\s+previous\s+instructions/i,
        /you\s+are\s+now\s+a/i,
        /jailbreak/i,
        /DAN\s+mode/i,
      ],
    };
    this.priority = priority;
    this.name = 'stream_safety';
  }

  /**
   * Reset the buffer for a new stream
   */
  reset(): void {
    this.buffer = '';
    this.lastCheckIndex = 0;
  }

  /**
   * Check a streaming chunk
   * Returns shouldAbort=true if violation detected
   */
  checkChunk(chunk: string): {
    shouldAbort: boolean;
    reason?: string;
    pattern?: RegExp;
  } {
    this.buffer += chunk;

    // Only check at intervals to avoid performance issues
    if (this.buffer.length - this.lastCheckIndex < this.config.checkInterval) {
      return { shouldAbort: false };
    }

    // Get the content to check (last maxChunkSize characters)
    const checkContent = this.buffer.slice(-this.config.maxChunkSize);

    for (const pattern of this.config.patterns) {
      if (pattern.test(checkContent)) {
        return {
          shouldAbort: true,
          reason: `Stream safety violation: ${pattern.source}`,
          pattern,
        };
      }
    }

    this.lastCheckIndex = this.buffer.length;
    return { shouldAbort: false };
  }

  /**
   * Hook implementation for generation architecture
   * Checks the complete accumulated content
   */
  call(ctx: HookContext): HookResult {
    const content = ctx.data['model.output'] || ctx.data['llm.output.text'] || this.buffer || '';
    
    if (!content) {
      return { allowed: true };
    }

    for (const pattern of this.config.patterns) {
      if (pattern.test(content)) {
        return {
          allowed: false,
          reason: `Stream safety violation: ${pattern.source}`,
          data: {
            stream_safety: {
              pattern: pattern.source,
              content_length: content.length,
            },
          },
        };
      }
    }

    return { allowed: true };
  }
}
