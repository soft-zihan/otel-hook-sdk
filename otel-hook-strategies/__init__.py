"""otel-hook strategies.

Independent strategy packages for otel-hook SDK.
"""

from .security import DangerousCommandHook, SensitiveDataHook
from .filter import WordFilterHook, PromptInjectionHook
from .audit import AuditHook
from .rate_limit import RateLimitHook

__all__ = [
    # Security
    "DangerousCommandHook",
    "SensitiveDataHook",
    # Filter
    "WordFilterHook",
    "PromptInjectionHook",
    # Audit
    "AuditHook",
    # Rate Limit
    "RateLimitHook",
]

__version__ = "0.1.0"
