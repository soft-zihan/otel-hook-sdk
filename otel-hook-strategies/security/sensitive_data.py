"""Sensitive data detection strategy."""

from typing import Optional, Set

from otel_hook import HookContext, HookResult


class SensitiveDataHook:
    """Detects sensitive data in data dict."""
    
    DEFAULT_SENSITIVE_KEYS = {"password", "secret", "token", "api_key", "private_key"}
    
    def __init__(
        self,
        sensitive_keys: Optional[Set[str]] = None,
        priority: int = 10,
    ) -> None:
        self.sensitive_keys = sensitive_keys or self.DEFAULT_SENSITIVE_KEYS
        self.priority = priority
        self.name = "sensitive_data"
    
    def __call__(self, ctx: HookContext) -> HookResult:
        for key in ctx.data:
            if any(s in key.lower() for s in self.sensitive_keys):
                return HookResult(allowed=False, reason=f"sensitive data detected: {key}")
        
        return HookResult(allowed=True)
