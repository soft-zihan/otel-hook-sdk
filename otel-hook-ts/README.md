# otel-hook (TypeScript)

基于 OpenTelemetry 的智能体可观测性 SDK，支持可插拔的 Hook 机制。

## 概述

三层解耦架构：

- **SDK**（本包）：纯机制，提供 Hook 接口、注册、执行和智能导出
- **策略**（otel-hook-strategies）：纯逻辑，提供安全、过滤、审计、限流等可复用策略
- **智能体**：组合 SDK + 策略

## 安装

```bash
cd otel-hook-ts
npm install
npm run build
```

## 快速开始

### 1. 初始化

```typescript
import { setupTracing, getTracer } from 'otel-hook';

setupTracing({
  serviceName: 'my-agent',
  otlpEndpoint: 'http://localhost:4317',
  cache: true,
});

const tracer = getTracer();
```

### 2. 注册策略

```typescript
import { registerHook, SpanNames } from 'otel-hook';
import { DangerousCommandHook, AuditHook } from 'otel-hook-strategies';

registerHook(SpanNames.TOOL_CALL, new DangerousCommandHook(), 'security', 10);
registerHook(SpanNames.TOOL_CALL, new AuditHook(), 'audit', 1000);
```

### 3. 自定义 Hook

```typescript
import { Hook, HookContext, HookResult, HookResultHelper } from 'otel-hook';

const myHook: Hook = (ctx: HookContext): HookResult => {
  if (ctx.attributes['tool.args']?.includes('dangerous')) {
    return HookResultHelper.deny('blocked');
  }
  return HookResultHelper.allow();
};
```

## 导出策略

一个 `cache` 开关：

| 场景 | cache=true | cache=false |
|------|------------|-------------|
| 在线 | 直接发送 | 直接发送 |
| 离线 | 缓存 → 恢复后续传 → 过期清理 | 丢弃 |

## 核心 API

### setupTracing

```typescript
function setupTracing(options?: {
  serviceName?: string;
  serviceVersion?: string;
  otlpEndpoint?: string;
  cache?: boolean;
  retryInterval?: number;
  expireSeconds?: number;
}): Tracer;
```

### Hook 接口

```typescript
interface HookContext {
  spanName: string;
  attributes: Record<string, any>;
  sessionId?: string;
  userId?: string;
  hookPoint: HookPoint;
  rawInput?: string;
  extra?: Record<string, any>;
}

interface HookResult {
  allowed: boolean;
  reason?: string;
  mutate?: Record<string, any>;
  extra?: Record<string, any>;
}

type Hook = (context: HookContext) => HookResult | Promise<HookResult>;
```

### registerHook / runHooks

```typescript
function registerHook(
  spanName: string,
  hook: Hook,
  name: string,
  priority?: number,
  config?: HookConfig
): void;

async function runHooks(context: HookContext): Promise<HookResult>;
```

## Span 名称

```typescript
const SpanNames = {
  AGENT_SESSION: 'agent.session',
  MODEL_CALL: 'llm.model_call',
  TOOL_CALL: 'tool.call',
  CHAIN: 'chain',
};
```

## 测试

```bash
npm test
```

## 设计原则

1. **三层解耦**：SDK（机制）/ 策略（逻辑）/ 智能体（组合）
2. **OTel 原生**：完全兼容 OpenTelemetry 标准
3. **轻量级**：最小化依赖
4. **可插拔**：Hook 动态注册、优先级编排、短路执行
5. **智能导出**：能发就发，发不出才缓存，恢复了续传，过期清理

## License

MIT
