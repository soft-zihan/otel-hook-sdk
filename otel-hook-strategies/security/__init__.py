"""Security strategies for otel-hook.

This module provides security-related hooks for detecting
dangerous operations and sensitive data.
"""

from .dangerous_cmd import DangerousCommandHook
from .sensitive_data import SensitiveDataHook

__all__ = [
    "DangerousCommandHook",
    "SensitiveDataHook",
]
