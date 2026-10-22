# StreamGuard 使用指南
## 三门流式安全防线 —— agent 无关的 SDK 内生能力

> 包：`otel-hook-strategies`（`src/security/stream-guard.ts`）
> 后端：`Qwen3Guard-Stream-4B` 本地安全小模型（可替换为任意 `GuardBackend` 实现）
> 实战验证：pi-from-scratch 19 家族攻防（见 `Safetymind_Pi_Attack_Defense_Report.md`）

---

## 1. 定位与语义

```
用户输入 ──► 门1 input_gen ──Unsafe≥threshold──► ⛔ 拦截（主模型零调用、零 token）
                │ Safe
                ▼
        主模型流式生成（任意 LLM/框架）
                │ 句子级 hold-back（最后一句扣住不发布）
                ▼
        门2 output_stream 增量检测 ──Unsafe≥threshold──► ⛔ abort 上游流
                │ Safe                                        （已发布文本均为过检安全文本）
                ▼
        流自然结束 ──► 门3 output_gen 终检 ──► ✅ 发布剩余文本
```

三条核心语义：

1. **hold-back 零暴露**：发布给用户的每个字符都已过检；拦截 = 违规文本从未到达用户（区别于"事后删消息"）。
2. **fail-closed（默认）**：审核后端异常 → 视为拦截，绝不假 Safe。可配 `failMode: 'open'` 降级放行（打 `guard.degraded` 标）。
3. **全量归因**：每次检测发射一个 Langfuse 兼容 GUARDRAIL span，携带 verdict / 置信度 / 延迟 / 拦截点 / 被拦截原文。

## 2. 快速开始

### 2.1 显式配置

```ts
import { createStreamGuard, guardServerAlive, runGuardedStream } from 'otel-hook-strategies'
import { setupTracing } from 'otel-hook'

setupTracing({ serviceName: 'my-agent', otlpEndpoint: '...' })   // 可选：不接 Langfuse 也能跑

const endpoint = 'http://localhost:8000'
if (!(await guardServerAlive(endpoint))) console.warn('守卫不可达')

const guard = createStreamGuard({
  endpoint,                    // 内部构造 Qwen3GuardHook（provider=python, mode=stream）
  threshold: 0.7,
  sessionId: 'lf-session-1',   // Langfuse 归组
  userId: 'alice',
  parentContext: rootSpanCtx,  // 所有 guard span 挂在该 context 下
})
```

### 2.2 环境变量（可配置调用项）

```ts
import { streamGuardFromEnv } from 'otel-hook-strategies'

const guard = streamGuardFromEnv()   // SAFE_GUARD=0 → null（对照组模式）
```

| 环境变量 | 默认 | 说明 |
|---|---|---|
| `SAFE_GUARD` | 启用 | `0` → `streamGuardFromEnv` 返回 `null`（完全关闭） |
| `QWEN3GUARD_ENDPOINT` | `http://localhost:8000` | guard server 地址 |
| `GUARD_THRESHOLD` | `0.7` | Unsafe 拦截置信度阈值 |
| `GUARD_TIMEOUT_MS` | `30000` | 后端超时 |
| `GUARD_FAIL_MODE` | `closed` | `open` → 后端异常降级放行 |
| `NO_INPUT_BLOCK` | 关 | `1` → 消融模式：门1 只打标不拦截（评测主模型自身防御） |
| `GUARD_SESSION_ID` / `GUARD_USER_ID` | - | Langfuse 归组/归因 |
| `GUARD_MIN_FLUSH_CHARS` | `40` | 句子边界提前 flush 的最小字符数 |
| `GUARD_MAX_BUF_CHARS` | `250` | 无标点长文（代码块）强制 flush 上限 |

### 2.3 高层包装器：任意流两行接入（门2+门3）

```ts
// source 可以是任何 AsyncIterable<string>（OpenAI SDK / fetch SSE / 自研管道）
// 传函数形式可获得内部 AbortSignal —— 拦截时自动 abort 上游 LLM 流
const result = await runGuardedStream(
  signal => openaiStreamDeltas(signal),
  guard,
  { onRelease: chunk => process.stdout.write(chunk) },   // 只回调过检文本
)

if (result.outcome === 'blocked') {
  console.log(`[拦截@${result.blocked!.atChar}字符] ${result.blocked!.reason}`)
  rollbackConversationTurn()          // 有害输出不进对话记忆
}
// result.releasedText / publishedChars / stats{checks,serverMs,wallMs}
```

门1 由调用方在发起 LLM 请求前执行：

```ts
const g = await guard.startTurn(messages)    // messages: {role, content}[]（含本轮用户输入）
if (g.blocked) {
  showNotice(g.reason)                        // 主模型零调用
  return
}
if (g.unsafeFlagged && !g.blocked) {
  // 消融模式命中：只打标（span 上有 guard.input_flagged_only）
}
```

### 2.4 低层 API（精细控制）

```ts
const evs = await guard.push(delta)   // 门2：返回 GuardEvent[]（released / blocked）
const fin = await guard.finish()      // 门3：终检剩余 hold-back 文本
await guard.close()                   // 关闭 guard session（幂等；runGuardedStream 会自动关）
guard.stats                           // { checks, serverMs, wallMs }
```

`GuardEvent`：

```ts
| { type: 'released'; text: string }                                    // 过检，可发布
| { type: 'blocked'; gate; reason; atChar; blockedText: string }        // 拦截；blockedText 未到达用户
```

## 3. 配置项（StreamGuardConfig）

| 字段 | 默认 | 说明 |
|---|---|---|
| `backend` / `hook` / `hookConfig` | - | 审核后端三选一（`backend` 为结构化接口，可 mock/换模型） |
| `endpoint`（createStreamGuard） | - | 便捷入口，内部构造 `Qwen3GuardHook` |
| `parentContext` | active context | guard span 的父 OTel context（async generator 场景务必显式传） |
| `sessionId` / `userId` | `''` | Langfuse 归组/归因 |
| `blockInput` | `true` | `false` = 消融模式（门1 只打标） |
| `failMode` | `'closed'` | `'open'` = 后端异常降级放行 |
| `minFlushChars` | `40` | hold-back 提前 flush 阈值 |
| `maxBufferChars` | `250` | 无标点强制 flush 阈值 |
| `sentenceSplitter` | 中英文标点+换行 | 自定义断句器 |
| `spanPrefix` / `guardName` | `hook.SafeGuard` / `SafeGuard` | span 命名 |
| `hookPriority` | `15` | span 上的 hook.priority |
| `historyWindow` | `4` | 门1 span Input 携带的最近消息条数 |
| `maxSpanTextChars` | `4000` | span IO 字段截断长度 |
| `tracer` | `getTracer()` | 覆盖 tracer（测试/多实例） |

## 4. Langfuse span 约定

| span 名 | 类型 | 关键属性 |
|---|---|---|
| `hook.SafeGuard.input_gen` | GUARDRAIL | `guard.prompt_label/category/confidence`、`guard.prompt_unsafe`、拦截时 `hook.blocked=true` + `guard.intercept_gate` |
| `hook.SafeGuard.output_stream#N` | GUARDRAIL | `guard.worst_*`、`guard.server_latency_ms`、`guard.wall_ms`、`stream.chars_checked`、拦截时 `guard.intercept_at_char` |
| `hook.SafeGuard.output_gen#N` | GUARDRAIL | 同上（门3 终检） |

- `langfuse.observation.input` = 被检文本（`checked_text`）；`langfuse.observation.output` = verdict JSON。
- 拦截 span `status=ERROR`，可按 level 过滤审计。
- 被拦截的主模型违规原文建议由集成方写入 GENERATION span 的 `langfuse.observation.output`（参考 pi `agent.ts` 的 `guardBlock` 路径），红队审计直接可见。

## 5. 替换后端（GuardBackend）

```ts
interface GuardBackend {
  startSession(msgs): Promise<SessionStartResult>   // 门1 + 建流式会话
  checkDelta(sessionId, delta): Promise<StreamCheckResult>   // 增量检测（KV-cache 前向）
  closeSession(sessionId): Promise<void>
}
```

任何实现该结构化接口的后端（其他安全模型、云端审核 API、mock）都可直接注入 `new StreamGuard({ backend })`。

## 6. 部署 guard server

```bash
cd otel-hook-sdk
python3 -u deploy/qwen3guard_server.py --port 8000 --device mps   # Apple Silicon
# 或 --device cuda；模型 Qwen/Qwen3Guard-Stream-4B（HF 自动下载）
```

提供 `/safety/check`（全文）与 `/safety/stream/start|check|close`（增量 KV-cache，~150-350ms/次）两组 API。

## 7. 测试与参考集成

- SDK 单测（25 例，mock 后端无需真实服务）：`otel-hook-strategies-ts/src/security/__tests__/stream-guard.test.ts`
- 参考集成（真实 agent loop + Langfuse + 记忆回滚 + TUI 拦截提示）：`pi-from-scratch/src/guard.ts`（薄适配）+ `src/agent.ts`
- 攻防评测脚本：`pi-from-scratch/scripts/pi-attack-demo.ts`（19 家族、逐轮分类、`ONLY_CASES`/`NO_INPUT_BLOCK`/`NO_GUARD`）
