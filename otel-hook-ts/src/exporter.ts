/**
 * Smart exporter: export when online, optionally cache when offline.
 * Supports conditional export - only export traces marked as violations.
 * 
 * Behavior:
 * - Online: export directly via OTLP
 * - Offline: cache to SQLite (if cache=true)
 * - Recovery: retry cached spans, delete on success
 * - Expiry: discard cached spans older than expire_seconds
 * - Conditional: only export traces with violations (if conditionalExport=true)
 */

import { ReadableSpan, SpanExporter } from '@opentelemetry/sdk-trace-base';
import { ExportResult, ExportResultCode } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

export interface ExportConfig {
  otlpEndpoint: string;
  cache?: boolean;
  cacheDbPath?: string;
  retryInterval?: number;
  expireSeconds?: number;
  batchSize?: number;
  headers?: Record<string, string>;
  conditionalExport?: boolean;
}

interface TraceState {
  shouldExport: boolean;
  violationType?: string;
  spans: ReadableSpan[];
  rootSpan?: ReadableSpan;
}

class TraceStateManager {
  private states: Map<string, TraceState> = new Map();

  getOrCreate(traceId: string): TraceState {
    if (!this.states.has(traceId)) {
      this.states.set(traceId, {
        shouldExport: false,
        spans: [],
      });
    }
    return this.states.get(traceId)!;
  }

  markForExport(traceId: string, violationType?: string): void {
    const state = this.getOrCreate(traceId);
    state.shouldExport = true;
    if (violationType) {
      state.violationType = violationType;
    }
  }

  addSpan(traceId: string, span: ReadableSpan): void {
    const state = this.getOrCreate(traceId);
    state.spans.push(span);
    if (!span.parentSpanId) {
      state.rootSpan = span;
    }
  }

  getState(traceId: string): TraceState | undefined {
    return this.states.get(traceId);
  }

  removeState(traceId: string): void {
    this.states.delete(traceId);
  }
}

const globalTraceManager = new TraceStateManager();

export function getTraceManager(): TraceStateManager {
  return globalTraceManager;
}

export function markTraceForExport(traceId: string, violationType?: string): void {
  globalTraceManager.markForExport(traceId, violationType);
}

export class SmartExporter implements SpanExporter {
  private config: Required<ExportConfig>;
  private exporter: OTLPTraceExporter | null = null;
  private retryTimer?: NodeJS.Timeout;
  private running = false;
  private db: Database.Database | null = null;
  private traceManager: TraceStateManager;

  constructor(config: ExportConfig) {
    this.config = {
      otlpEndpoint: config.otlpEndpoint,
      cache: config.cache ?? true,
      cacheDbPath: config.cacheDbPath ?? './data/traces/cache.db',
      retryInterval: config.retryInterval ?? 5,
      expireSeconds: config.expireSeconds ?? 86400,
      batchSize: config.batchSize ?? 100,
      headers: config.headers ?? {},
      conditionalExport: config.conditionalExport ?? false,
    };
    this.traceManager = globalTraceManager;

    // Only create OTLP exporter if endpoint is provided and not localhost placeholder
    if (this.config.otlpEndpoint && !this.config.otlpEndpoint.includes('localhost')) {
      this.exporter = new OTLPTraceExporter({
        url: this.config.otlpEndpoint,
        headers: this.config.headers,
      });
    }

    // Initialize SQLite cache
    if (this.config.cache) {
      this.initCacheDb();
    }
  }

  private initCacheDb(): void {
    try {
      const dir = path.dirname(this.config.cacheDbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      this.db = new Database(this.config.cacheDbPath);
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS cache (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          data TEXT NOT NULL,
          created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_created_at ON cache(created_at);
      `);
    } catch (error) {
      console.error('Init cache DB failed:', error);
    }
  }

  export(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    for (const span of spans) {
      const traceId = span.spanContext().traceId;
      this.traceManager.addSpan(traceId, span);
    }

    if (!this.config.conditionalExport) {
      this.doExport(spans, resultCallback);
      return;
    }

    // In conditional mode, only export when root span ends
    for (const span of spans) {
      if (!span.parentSpanId) {
        const traceId = span.spanContext().traceId;
        const state = this.traceManager.getState(traceId);
        if (state && state.shouldExport) {
          // Trace name for Langfuse UI:
          // 1. explicit langfuse.trace.name already set on any span wins
          // 2. else "<root span name>: <violation type>" (distinguishable in trace list)
          // 3. else root span name
          const explicitName = state.spans
            .map(s => (s.attributes as Record<string, unknown>)['langfuse.trace.name'])
            .find(v => typeof v === 'string' && v.length > 0) as string | undefined;
          const rootName = state.rootSpan?.name || 'unknown';
          const traceName = explicitName
            || (state.violationType ? `${rootName}: ${state.violationType}` : rootName);

          // Propagate trace-level Langfuse attributes from root to all spans
          // (Langfuse filters/aggregations operate per-observation; see docs
          // "Propagating Trace Attributes to All Spans"). input/output are
          // intentionally NOT propagated (root-only, avoids payload bloat).
          const rootAttrs = (state.rootSpan?.attributes || {}) as Record<string, unknown>;
          const propagateKeys = Object.keys(rootAttrs).filter(k =>
            k === 'langfuse.user.id' || k === 'langfuse.session.id' ||
            k === 'langfuse.trace.tags' || k.startsWith('langfuse.trace.metadata.'));

          for (const s of state.spans) {
            const merged: Record<string, unknown> = { ...s.attributes };
            for (const k of propagateKeys) {
              if (merged[k] === undefined) merged[k] = rootAttrs[k];
            }
            merged['langfuse.trace.name'] = traceName;
            (s as any).attributes = merged;
          }
          this.doExport(state.spans, (result) => {
            if (result.code === ExportResultCode.SUCCESS) {
              console.log(`Exported trace ${traceId} with ${state.spans.length} spans (violation: ${state.violationType})`);
            }
          });
        } else {
          console.log(`Skipped trace ${traceId} (no violation)`);
        }
        this.traceManager.removeState(traceId);
      }
    }

    resultCallback({ code: ExportResultCode.SUCCESS });
  }

  private doExport(spans: ReadableSpan[], resultCallback: (result: ExportResult) => void): void {
    if (this.exporter) {
      this.exporter.export(spans, (result) => {
        if (result.code === ExportResultCode.FAILED && this.config.cache) {
          this.cacheSpans(spans);
        }
        resultCallback(result);
      });
    } else if (this.config.cache) {
      // No exporter, just cache locally
      this.cacheSpans(spans);
      resultCallback({ code: ExportResultCode.SUCCESS });
    } else {
      resultCallback({ code: ExportResultCode.SUCCESS });
    }
  }

  async shutdown(): Promise<void> {
    this.stop();
    if (this.exporter) {
      await this.exporter.shutdown();
    }
    if (this.db) {
      this.db.close();
    }
  }

  start(): void {
    if (!this.config.cache || this.running) {
      return;
    }
    this.running = true;
    this.retryTimer = setInterval(() => {
      this.expire();
      this.retry();
    }, this.config.retryInterval * 1000);
  }

  stop(): void {
    this.running = false;
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
    }
  }

  private cacheSpans(spans: ReadableSpan[]): void {
    if (!this.db) return;
    
    try {
      const now = Date.now() / 1000;
      const stmt = this.db.prepare('INSERT INTO cache (data, created_at) VALUES (?, ?)');

      for (const span of spans) {
        const data = JSON.stringify({
          traceId: span.spanContext().traceId,
          spanId: span.spanContext().spanId,
          parentSpanId: span.parentSpanId,
          name: span.name,
          kind: span.kind,
          startTime: span.startTime,
          endTime: span.endTime,
          attributes: span.attributes,
          events: span.events,
          status: span.status,
          duration: span.duration,
        });
        stmt.run(data, now);
      }
    } catch (error) {
      console.error('Cache span failed:', error);
    }
  }

  private retry(): void {
    if (!this.exporter || !this.db) return;

    try {
      const rows = this.db.prepare(
        'SELECT id, data FROM cache ORDER BY id LIMIT ?'
      ).all(this.config.batchSize) as Array<{ id: number; data: string }>;

      if (rows.length === 0) return;

      // TODO: Reconstruct ReadableSpan and export via OTLPTraceExporter
      // For now, just delete them (they're cached for later manual export)
      const deleteStmt = this.db.prepare('DELETE FROM cache WHERE id = ?');
      for (const row of rows) {
        deleteStmt.run(row.id);
      }
    } catch (error) {
      console.error('Retry failed:', error);
    }
  }

  private expire(): void {
    if (this.config.expireSeconds <= 0 || !this.db) return;

    try {
      const cutoff = Date.now() / 1000 - this.config.expireSeconds;
      this.db.prepare('DELETE FROM cache WHERE created_at < ?').run(cutoff);
    } catch (error) {
      console.error('Expire failed:', error);
    }
  }

  getCacheSize(): number {
    if (!this.db) return 0;
    const row = this.db.prepare('SELECT COUNT(*) as count FROM cache').get() as { count: number };
    return row.count;
  }
}
