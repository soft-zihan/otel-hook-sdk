# otel-hook-strategies

独立的策略包，为 otel-hook SDK 提供可复用的 Hook 实现。

## 概述

本包提供了一系列独立的安全、过滤、审计和限流策略，可以与 otel-hook SDK 配合使用。

**特点**：
- **独立于 SDK**：策略逻辑与 SDK 机制完全分离
- **跨语言复用**：Python 实现，TS 通过子进程调用
- **可独立测试**：每个策略都可以单独测试
- **可配置**：所有策略都支持自定义配置

> **注**：模型级安全审核能力（`Qwen3GuardHook` / `StreamGuard` 三门流式防线）目前仅在 TypeScript 策略包（`otel-hook-strategies-ts`）提供，用法见 [docs/stream-guard.md](../docs/stream-guard.md)；Python 版尚未移植。

## 架构

```
┌─────────────────────────────────────────┐
│         Agents (mini-swe-agent,         │
│         pi-from-scratch, etc.)          │
└─────────────────┬───────────────────────┘
                  │ 使用
┌─────────────────▼───────────────────────┐
│      otel-hook SDK (Py / TS)            │
│      - Hook 机制                        │
│      - 导出机制                         │
└─────────────────┬───────────────────────┘
                  │ 调用
┌─────────────────▼───────────────────────┐
│      otel-hook-strategies               │
│      - security/                        │
│      - filter/                          │
│      - audit/                           │
│      - rate_limit/                      │
└─────────────────────────────────────────┘
```

## 安装

```bash
pip install -e .
```

## 可用策略

### Security（安全策略）

#### DangerousCommandHook

检测危险命令。

```python
from security import DangerousCommandHook

hook = DangerousCommandHook(
    patterns=[r"rm\s+-rf", r"DROP\s+TABLE"],  # 可选
    priority=10,
)
```

**默认检测**：
- `rm -rf`
- `DROP TABLE`
- `DELETE FROM`
- `/etc/passwd`
- `mkfs`
- `dd if=`

#### SensitiveDataHook

检测敏感数据。

```python
from security import SensitiveDataHook

hook = SensitiveDataHook(
    sensitive_keys={"password", "secret", "token"},  # 可选
    priority=10,
)
```

**默认检测**：
- `password`
- `secret`
- `token`
- `api_key`
- `private_key`

### Filter（过滤策略）

#### WordFilterHook

过滤敏感词。

```python
from filter import WordFilterHook

hook = WordFilterHook(
    sensitive_words=["暴力", "色情", "赌博"],  # 可选
    priority=15,
)
```

**默认敏感词**：
- 暴力
- 色情
- 赌博
- 毒品
- 枪支
- 爆炸物

#### PromptInjectionHook

检测 prompt 注入攻击。

```python
from filter import PromptInjectionHook

hook = PromptInjectionHook(
    patterns=[r"ignore\s+previous\s+instructions"],  # 可选
    priority=25,
)
```

**默认检测**：
- `ignore previous instructions`
- `you are now a`
- `system:`
- `jailbreak`
- `DAN mode`

### Audit（审计策略）

#### AuditHook

记录审计日志。

```python
from audit import AuditHook

hook = AuditHook(priority=1000)
```

**功能**：
- 记录 span 名称
- 记录 session ID
- 记录时间戳
- 始终允许

### Rate Limit（限流策略）

#### RateLimitHook

频率限制。

```python
from rate_limit import RateLimitHook

hook = RateLimitHook(
    max_calls_per_minute=60,
    priority=30,
)
```

## 使用示例

### Python

```python
from otel_hook import setup_tracing, register_hook, SpanNames
from security import DangerousCommandHook, SensitiveDataHook
from filter import WordFilterHook
from audit import AuditHook

# 初始化 SDK
setup_tracing(
    service_name="my-agent",
    cache=True,
)

# 注册 hooks
register_hook(SpanNames.TOOL_CALL, DangerousCommandHook(), "security", 10)
register_hook(SpanNames.TOOL_CALL, SensitiveDataHook(), "sensitive", 10)
register_hook(SpanNames.MODEL_CALL, WordFilterHook(), "filter", 15)
register_hook(SpanNames.TOOL_CALL, AuditHook(), "audit", 1000)
```

### TypeScript

```typescript
import { setupTracing, registerHook, SpanNames } from 'otel-hook';
import { DangerousCommandHook, AuditHook } from 'otel-hook-strategies';

// 初始化 SDK
setupTracing({
  serviceName: 'my-agent',
  cache: true,
});

// 注册 hooks
registerHook(SpanNames.TOOL_CALL, new DangerousCommandHook(), 'security', 10);
registerHook(SpanNames.TOOL_CALL, new AuditHook(), 'audit', 1000);
```

## 测试

```bash
pytest tests/
```

## 自定义策略

创建自定义策略非常简单：

```python
from otel_hook import Hook, HookContext, HookResult

class MyCustomHook:
    def __init__(self, priority: int = 50):
        self.priority = priority
        self.name = "my_custom"
    
    def __call__(self, ctx: HookContext) -> HookResult:
        # 你的逻辑
        if some_condition:
            return HookResult.deny("reason")
        return HookResult.allow()
```

## License

MIT
