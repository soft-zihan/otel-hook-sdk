"""Dangerous command detection strategy."""

import re
from typing import List, Optional

from otel_hook import HookContext, HookResult


class DangerousCommandHook:
    """Detects dangerous commands in tool arguments."""
    
    DEFAULT_PATTERNS = [
        r"rm\s+-rf",
        r"DROP\s+TABLE",
        r"DELETE\s+FROM",
        r"/etc/passwd",
        r"mkfs",
        r"dd\s+if=",
        r">\s*/dev/[sh]d[a-z]",
    ]
    
    def __init__(
        self,
        patterns: Optional[List[str]] = None,
        priority: int = 10,
    ) -> None:
        self.patterns = [re.compile(p, re.IGNORECASE) for p in (patterns or self.DEFAULT_PATTERNS)]
        self.priority = priority
        self.name = "dangerous_command"
    
    def __call__(self, ctx: HookContext) -> HookResult:
        args = str(ctx.data.get("tool.args", ""))
        
        for pattern in self.patterns:
            if pattern.search(args):
                return HookResult(allowed=False, reason=f"dangerous operation detected: {pattern.pattern}")
        
        return HookResult(allowed=True)
