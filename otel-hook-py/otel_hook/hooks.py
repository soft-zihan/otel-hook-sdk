"""Hook mechanism for otel-hook SDK.

The SDK provides the mechanism only:
- Run hooks in priority order per event
- Create spans for each hook execution (timing, errors)
- Collect and return results
- Mark trace for export when violation detected

The SDK does NOT prescribe what hook results mean.
Each agent interprets results however it needs to.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional
from opentelemetry import trace as otel_trace
from opentelemetry.trace import StatusCode

from .exporter import mark_trace_for_export


@dataclass
class HookContext:
    """Context passed to hooks. Minimal by design."""
    data: Dict[str, Any] = field(default_factory=dict)


@dataclass
class HookResult:
    """Unified result from a hook."""
    allowed: bool
    reason: Optional[str] = None
    data: Optional[Dict[str, Any]] = None


Hook = Callable[[HookContext], HookResult]


@dataclass
class HookConfig:
    """Configuration for a hook."""
    timeout_ms: int = 1000
    enabled: bool = True


class HookWrapper:
    """Wrapper for a hook with configuration and priority."""

    def __init__(
        self,
        hook: Hook,
        name: str,
        priority: int = 50,
        config: Optional[HookConfig] = None,
    ) -> None:
        self.hook = hook
        self.name = name
        self.priority = priority
        self.config = config or HookConfig()

    def __call__(self, context: HookContext) -> Optional[HookResult]:
        """Execute the hook. Returns None if disabled."""
        if not self.config.enabled:
            return None
        return self.hook(context)


class HookChain:
    """Chain of hooks executed in priority order."""

    def __init__(self, hooks: List[HookWrapper]) -> None:
        self.hooks: List[HookWrapper] = sorted(hooks, key=lambda h: h.priority)

    def run(self, context: HookContext) -> List[HookResult]:
        """Execute all hooks and return list of results."""
        results: List[HookResult] = []
        tracer = otel_trace.get_tracer("otel-hook")
        current_span = otel_trace.get_current_span()
        span_ctx = current_span.get_span_context() if current_span else None
        trace_id = f"{span_ctx.trace_id:032x}" if span_ctx else None

        for wrapper in self.hooks:
            if not wrapper.config.enabled:
                continue

            import time
            start = time.time()
            hook_span = tracer.start_span(f"hook.{wrapper.name}", attributes={
                "hook.name": wrapper.name,
                "hook.priority": wrapper.priority,
            })

            result: Optional[HookResult] = None
            error = None
            try:
                result = wrapper.hook(context)
            except Exception as e:
                error = e

            duration_ms = (time.time() - start) * 1000
            hook_span.set_attributes({
                "hook.duration_ms": duration_ms,
                "hook.error": str(error) if error else "",
            })

            if error:
                hook_span.set_status(StatusCode.ERROR, str(error))
                results.append(HookResult(allowed=False, reason=str(error)))
                if trace_id:
                    mark_trace_for_export(trace_id, "hook_error")
            elif result is None:
                hook_span.set_status(StatusCode.OK)
            else:
                hook_span.set_attributes({
                    "hook.allowed": result.allowed,
                    "hook.blocked": not result.allowed,
                    "hook.reason": result.reason or "",
                })
                if result.data:
                    import json
                    hook_span.set_attribute("hook.data", json.dumps(result.data, default=str))
                
                if not result.allowed:
                    hook_span.set_status(StatusCode.ERROR, result.reason or "blocked")
                    if trace_id:
                        mark_trace_for_export(trace_id, wrapper.name)
                else:
                    hook_span.set_status(StatusCode.OK)
                results.append(result)

            hook_span.end()

        return results


class HookRegistry:
    """Registry for managing hooks per event."""

    def __init__(self) -> None:
        self._hooks: Dict[str, HookChain] = {}

    def register(
        self,
        event: str,
        hook: Hook,
        name: str,
        priority: int = 50,
        config: Optional[HookConfig] = None,
    ) -> None:
        """Register a hook for an event."""
        wrapper = HookWrapper(hook, name, priority, config)

        if event not in self._hooks:
            self._hooks[event] = HookChain([wrapper])
        else:
            self._hooks[event].hooks.append(wrapper)
            self._hooks[event].hooks.sort(key=lambda h: h.priority)

    def get(self, event: str) -> Optional[HookChain]:
        """Get hook chain for an event."""
        return self._hooks.get(event)

    def run(self, event: str, context: HookContext) -> List[HookResult]:
        """Run all hooks for an event."""
        chain = self.get(event)
        if chain:
            return chain.run(context)
        return []


_global_registry: HookRegistry = HookRegistry()


def register_hook(
    event: str,
    hook: Hook,
    name: str,
    priority: int = 50,
    config: Optional[HookConfig] = None,
) -> None:
    """Register a hook to the global registry."""
    _global_registry.register(event, hook, name, priority, config)


def run_hooks(event: str, context: HookContext) -> List[HookResult]:
    """Run all registered hooks for an event.

    Returns a list of HookResult, one per hook, in priority order.
    The agent interprets each result however it needs.
    """
    return _global_registry.run(event, context)
