# otel-hook-strategies (TypeScript)

独立的策略包，为 otel-hook SDK 提供可复用的 Hook 实现。

## 概述

本包提供了一系列独立的安全、过滤、审计和限流策略，可以与 otel-hook SDK 配合使用。

**特点**：
- **独立于 SDK**：策略逻辑与 SDK 机制完全分离
- **跨语言一致**：与 Python 版本策略功能一致
- **可独立测试**：每个策略都可以单独测试
- **可配置**：所有策略都支持自定义配置

## 安装

```bash
cd otel-hook-strategies-ts
npm install
npm run build
```

## 可用策略

### Security（安全策略）

| 策略 | 说明 | 默认优先级 |
|------|------|-----------|
| `DangerousCommandHook` | 检测 `rm -rf`, `DROP TABLE`, `/etc/passwd` 等 | 10 |
| `SensitiveDataHook` | 检测 `password`, `secret`, `token` 等 | 10 |
| `Qwen3GuardHook` | Qwen3Guard-Stream-4B 本地安全小模型审核（全文 + 增量流式会话 API） | 15 |
| `StreamGuard` | **三门流式防线**（input_gen / output_stream hold-back / output_gen），agent 无关、可配置、fail-closed，Langfuse 全量归因 → [使用指南](../docs/stream-guard.md) | 15 |

### Filter（过滤策略）

| 策略 | 说明 | 默认优先级 |
|------|------|-----------|
| `WordFilterHook` | 过滤敏感词（暴力、色情等） | 15 |
| `PromptInjectionHook` | 检测 prompt 注入攻击 | 25 |

### Audit（审计策略）

| 策略 | 说明 | 默认优先级 |
|------|------|-----------|
| `AuditHook` | 记录审计日志（始终放行） | 1000 |

### Rate Limit（限流策略）

| 策略 | 说明 | 默认优先级 |
|------|------|-----------|
| `RateLimitHook` | 频率限制（每分钟最大调用数） | 30 |

## 使用示例

```typescript
import { setupTracing, registerHook, SpanNames } from 'otel-hook';
import {
  DangerousCommandHook,
  WordFilterHook,
  AuditHook,
} from 'otel-hook-strategies';

// 初始化 SDK
setupTracing({
  serviceName: 'my-agent',
  cache: true,
});

// 注册 hooks
registerHook(SpanNames.TOOL_CALL, new DangerousCommandHook(), 'security', 10);
registerHook(SpanNames.MODEL_CALL, new WordFilterHook(), 'filter', 15);
registerHook(SpanNames.TOOL_CALL, new AuditHook(), 'audit', 1000);
```

### StreamGuard 三门流式防线

```typescript
import { createStreamGuard, runGuardedStream, guardServerAlive } from 'otel-hook-strategies';

const endpoint = 'http://localhost:8000';   // deploy/qwen3guard_server.py
if (await guardServerAlive(endpoint)) {
  const guard = createStreamGuard({ endpoint, sessionId: 'lf-session', userId: 'alice', parentContext });

  const g = await guard.startTurn(messages);              // 门1：输入审核（Unsafe≥0.7 → 主模型零调用）
  if (!g.blocked) {
    const r = await runGuardedStream(                      // 门2+门3：hold-back 流式审核
      signal => myLlmStream(signal), guard,
      { onRelease: chunk => render(chunk) },               // 只回调过检文本，拦截 = 零暴露
    );
    if (r.outcome === 'blocked') rollbackTurn(r.blocked);
  }
}
```

完整配置项（阈值 / failMode / 消融模式 / 断句器 / 环境变量）、Langfuse span 约定与后端替换见 [docs/stream-guard.md](../docs/stream-guard.md)。

## 自定义策略

```typescript
import { Hook, HookContext, HookResult, HookResultHelper } from 'otel-hook';

class MyCustomHook {
  priority = 50;
  name = 'my_custom';

  call(ctx: HookContext): HookResult {
    if (someCondition) {
      return HookResultHelper.deny('reason');
    }
    return HookResultHelper.allow();
  }
}
```

## 测试

```bash
npm test
```

## License

MIT
