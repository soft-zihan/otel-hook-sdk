/**
 * otel-hook: OpenTelemetry-based agent observability SDK with pluggable hooks.
 */

export {
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
} from './hooks';

export { SpanNames, SpanAttributes } from './spans';

export { 
  ExportConfig, 
  SmartExporter,
  markTraceForExport,
  getTraceManager,
} from './exporter';

export {
  SetupTracingOptions,
  setupTracing,
  getTracer,
  shutdownTracing,
} from './provider';
