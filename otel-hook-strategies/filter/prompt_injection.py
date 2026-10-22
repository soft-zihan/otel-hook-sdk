"""Prompt injection detection strategy."""

import re
from typing import List, Optional

from otel_hook import HookContext, HookResult


class PromptInjectionHook:
    """Detects prompt injection attempts."""
    
    DEFAULT_PATTERNS = [
        r"ignore\s+previous\s+instructions",
        r"you\s+are\s+now\s+a",
        r"system:",
        r"jailbreak",
        r"DAN\s+mode",
    ]
    
    def __init__(
        self,
        patterns: Optional[List[str]] = None,
        priority: int = 25,
    ) -> None:
        self.patterns = [re.compile(p, re.IGNORECASE) for p in (patterns or self.DEFAULT_PATTERNS)]
        self.priority = priority
        self.name = "prompt_injection"
    
    def __call__(self, ctx: HookContext) -> HookResult:
        text = ctx.data.get("raw_input", "")
        
        for pattern in self.patterns:
            if pattern.search(text):
                return HookResult(allowed=False, reason=f"prompt injection detected: {pattern.pattern}")
        
        return HookResult(allowed=True)
