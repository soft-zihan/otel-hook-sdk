"""Word filter strategy."""

from typing import List, Optional

from otel_hook import HookContext, HookResult


class WordFilterHook:
    """Filters sensitive words in LLM input/output."""
    
    DEFAULT_SENSITIVE_WORDS = ["暴力", "色情", "赌博", "毒品", "枪支", "爆炸物"]
    
    def __init__(
        self,
        sensitive_words: Optional[List[str]] = None,
        priority: int = 15,
    ) -> None:
        self.sensitive_words = sensitive_words or self.DEFAULT_SENSITIVE_WORDS
        self.priority = priority
        self.name = "word_filter"
    
    def __call__(self, ctx: HookContext) -> HookResult:
        text = ctx.data.get("raw_input", "")
        for word in self.sensitive_words:
            if word in text:
                return HookResult(allowed=False, reason=f"sensitive word detected: '{word}'")
        
        return HookResult(allowed=True)
