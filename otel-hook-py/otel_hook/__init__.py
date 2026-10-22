"""otel-hook: OpenTelemetry-based agent observability SDK with pluggable hooks."""

from .hooks import (
    HookContext,
    HookResult,
    HookConfig,
    Hook,
    HookWrapper,
    HookChain,
    HookRegistry,
    register_hook,
    run_hooks,
)
from .spans import SpanNames, SpanAttributes
from .exporter import ExportConfig, SmartExporter, mark_trace_for_export, get_trace_manager
from .provider import setup_tracing, get_tracer, shutdown_tracing

__all__ = [
    # Hooks
    "HookContext",
    "HookResult",
    "HookConfig",
    "Hook",
    "HookWrapper",
    "HookChain",
    "HookRegistry",
    "register_hook",
    "run_hooks",
    # Spans
    "SpanNames",
    "SpanAttributes",
    # Exporter
    "ExportConfig",
    "SmartExporter",
    "mark_trace_for_export",
    "get_trace_manager",
    # Provider
    "setup_tracing",
    "get_tracer",
    "shutdown_tracing",
]
