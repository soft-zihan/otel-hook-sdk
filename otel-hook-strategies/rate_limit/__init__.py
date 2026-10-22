"""Rate limit strategies for otel-hook.

This module provides rate limiting hooks.
"""

import time
from typing import Dict, List

from otel_hook import HookContext, HookResult


class RateLimitHook:
    """Rate limiting for API calls."""
    
    def __init__(
        self,
        max_calls_per_minute: int = 60,
        priority: int = 30,
    ) -> None:
        self.max_calls = max_calls_per_minute
        self.calls: Dict[str, List[float]] = {}
        self.priority = priority
        self.name = "rate_limit"
    
    def __call__(self, ctx: HookContext) -> HookResult:
        session_id = ctx.data.get("session_id", "default")
        now = time.time()
        
        if session_id not in self.calls:
            self.calls[session_id] = []
        
        # Remove old calls
        self.calls[session_id] = [
            t for t in self.calls[session_id] if now - t < 60
        ]
        
        if len(self.calls[session_id]) >= self.max_calls:
            return HookResult(allowed=False, reason=f"rate limit exceeded: {self.max_calls}/minute")
        
        self.calls[session_id].append(now)
        return HookResult(allowed=True)
