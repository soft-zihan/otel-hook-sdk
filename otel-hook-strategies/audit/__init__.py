"""Audit strategies for otel-hook.

This module provides audit logging hooks.
"""

import time
from typing import Optional

from otel_hook import HookContext, HookResult


class AuditHook:
    """Logs audit information (always allows)."""
    
    def __init__(self, priority: int = 1000) -> None:
        self.priority = priority
        self.name = "audit"
    
    def __call__(self, ctx: HookContext) -> HookResult:
        print(f"[AUDIT] session={ctx.data.get('session_id', 'unknown')} ts={time.time()}")
        return HookResult(allowed=True)
