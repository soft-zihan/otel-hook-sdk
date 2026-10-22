/**
 * TracerProvider setup.
 */

import { trace, Tracer } from '@opentelemetry/api';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { ExportConfig, SmartExporter } from './exporter';

let provider: NodeTracerProvider | null = null;

export interface SetupTracingOptions {
  serviceName?: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
  cache?: boolean;
  cacheDbPath?: string;
  retryInterval?: number;
  expireSeconds?: number;
  headers?: Record<string, string>;
  conditionalExport?: boolean;
}

export function setupTracing(options: SetupTracingOptions = {}): Tracer {
  const {
    serviceName = 'otel-hook',
    serviceVersion = '0.1.0',
    otlpEndpoint,
    cache = true,
    cacheDbPath = './data/traces/cache.db',
    retryInterval = 5,
    expireSeconds = 86400,
    headers = {},
    conditionalExport = false,
  } = options;

  if (provider) {
    console.warn('Tracing already initialized');
    return provider.getTracer(serviceName);
  }

  const resource = new Resource({
    [SemanticResourceAttributes.SERVICE_NAME]: serviceName,
    [SemanticResourceAttributes.SERVICE_VERSION]: serviceVersion,
  });

  provider = new NodeTracerProvider({
    resource,
  });

  const config: ExportConfig = {
    otlpEndpoint: otlpEndpoint || 'http://localhost:4317',
    cache,
    cacheDbPath,
    retryInterval,
    expireSeconds,
    headers,
    conditionalExport,
  };
  const exporter = new SmartExporter(config);
  
  provider.addSpanProcessor({
    onStart: () => {},
    onEnd: (span: any) => exporter.export([span], () => {}),
    shutdown: () => exporter.shutdown(),
    forceFlush: () => Promise.resolve(),
  } as any);
  
  if (cache) {
    exporter.start();
  }
  
  if (otlpEndpoint) {
    console.log(`Tracing: endpoint=${otlpEndpoint}, cache=${cache}, conditional=${conditionalExport}`);
  } else {
    console.log(`Tracing: cache-only mode, db=${cacheDbPath}, conditional=${conditionalExport}`);
  }

  provider.register();
  return provider.getTracer(serviceName);
}

export function getTracer(name: string = 'otel-hook'): Tracer {
  if (!provider) {
    console.warn('Tracing not initialized');
    return trace.getTracer(name);
  }
  return provider.getTracer(name);
}

export async function shutdownTracing(): Promise<void> {
  if (provider) {
    await provider.shutdown();
    provider = null;
  }
}
