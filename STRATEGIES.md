# 编写策略

策略就是一个函数或类，你在里面写什么代码都行——发通知、记日志、改参数、抛异常、返回任意东西。SDK 只负责执行和记录，不解释返回值。

## 最小策略

```python
from otel_hook import HookContext, HookResult

def my_hook(ctx: HookContext) -> HookResult:
    # 做什么完全由你定义
    print(f"Tool {ctx.data.get('tool.name')} called")
    return HookResult(allowed=True)
```

```typescript
import { HookContext, HookResult } from 'otel-hook'

function myHook(ctx: HookContext): HookResult {
  // 做什么完全由你定义
  console.log(`Tool ${ctx.data['tool.name']} called`)
  return { allowed: true }
}
```

## 策略类

把逻辑封装成类，支持参数化和状态：

```python
from otel_hook import HookContext, HookResult

class DangerousCommandHook:
    PATTERNS = [r"rm\s+-rf", r"DROP\s+TABLE", r"/etc/passwd"]

    def __init__(self, patterns=None, priority=10):
        import re
        self.patterns = [re.compile(p, re.IGNORECASE) for p in (patterns or self.PATTERNS)]
        self.priority = priority
        self.name = "dangerous_command"

    def __call__(self, ctx: HookContext) -> HookResult:
        args = str(ctx.data.get("tool.args", ""))
        for pattern in self.patterns:
            if pattern.search(args):
                return HookResult(allowed=False, reason=f'dangerous: {pattern.pattern}')
        return HookResult(allowed=True)
```

## HookContext

```python
@dataclass
class HookContext:
    data: dict  # 当前上下文数据（灵活，按 event 不同而不同）
```

`data` 里放什么完全由 agent 决定。例如：

```python
# tool_call 事件
ctx = HookContext(data={
    "tool.name": "read_file",
    "tool.args": {"path": "/tmp/test.txt"},
    "session_id": "123",
})

# model_call 事件
ctx = HookContext(data={
    "llm.model": "gpt-4o",
    "llm.input.messages": [...],
    "session_id": "123",
})
```

## HookResult

```python
@dataclass
class HookResult:
    allowed: bool           # True=继续，False=拦截
    reason: str | None      # 拦截原因
    data: dict | None       # 修改后的数据（None=不修改）
```

## 示例策略

### 危险命令检测

```python
class DangerousCommandHook:
    PATTERNS = [r"rm\s+-rf", r"DROP\s+TABLE", r"/etc/passwd", r"mkfs"]

    def __call__(self, ctx: HookContext) -> HookResult:
        args = str(ctx.data.get("tool.args", ""))
        for p in self.PATTERNS:
            if re.search(p, args, re.IGNORECASE):
                return HookResult(allowed=False, reason=f'dangerous: {p}')
        return HookResult(allowed=True)
```

### 敏感词过滤

```python
class WordFilterHook:
    def __init__(self, words=None):
        self.words = words or ["暴力", "色情", "赌博"]

    def __call__(self, ctx: HookContext) -> HookResult:
        text = ctx.data.get("raw_input", "")
        for w in self.words:
            if w in text:
                return HookResult(allowed=False, reason=f'sensitive word: {w}')
        return HookResult(allowed=True)
```

### 参数修改

```python
class SanitizeHook:
    def __call__(self, ctx: HookContext) -> HookResult:
        args = ctx.data.get("args", {})
        args["path"] = args["path"].replace("..", "")
        return HookResult(allowed=True, data={"args": args})
```

### 频率限制

```python
class RateLimitHook:
    def __init__(self, max_per_minute=60):
        self.max = max_per_minute
        self.calls = {}

    def __call__(self, ctx: HookContext) -> HookResult:
        sid = ctx.data.get("session_id", "default")
        now = time.time()
        self.calls.setdefault(sid, [])
        self.calls[sid] = [t for t in self.calls[sid] if now - t < 60]
        if len(self.calls[sid]) >= self.max:
            return HookResult(allowed=False, reason=f'rate limit: {self.max}/min')
        self.calls[sid].append(now)
        return HookResult(allowed=True)
```

### 审计日志

```python
class AuditHook:
    def __call__(self, ctx: HookContext) -> HookResult:
        print(f"[AUDIT] session={ctx.data.get('session_id', 'unknown')} ts={time.time()}")
        return HookResult(allowed=True)
```

## 注册

```python
from otel_hook import register_hook

register_hook("tool_call", DangerousCommandHook(), "security", priority=10)
register_hook("tool_call", AuditHook(), "audit", priority=1000)
```

## 智能体如何使用 Hook 结果

每个智能体根据自己的需求处理 Hook 的返回值：

### 拦截

```python
results = run_hooks("tool_call", ctx)
for result in results:
    if not result.allowed:
        return f"blocked: {result.reason}"
```

### 使用修改后的数据

```python
results = run_hooks("tool_call", ctx)
for result in results:
    if result.data:
        args = result.data.get("args", args)
```

### 混合使用

```python
# Hook 1：拦截
def security_hook(ctx):
    if 'bad' in ctx.data.get('tool.args', ''):
        return HookResult(allowed=False, reason='blocked')
    return HookResult(allowed=True)

# Hook 2：修改参数
def sanitize_hook(ctx):
    args = ctx.data.get('args', {})
    args['path'] = args['path'].replace('..', '')
    return HookResult(allowed=True, data={'args': args})

# Hook 3：只记日志
def audit_hook(ctx):
    print(f"[AUDIT] {ctx.data}")
    return HookResult(allowed=True)
```

## 策略包

`otel-hook-strategies` 是上述示例的打包，供快速试用。生产环境建议基于上面的模式编写自己的策略。

```bash
cd otel-hook-strategies && pip install -e .
```

```python
from otel_hook_strategies import DangerousCommandHook, AuditHook
```

## 进阶：模型级安全审核策略（TypeScript）

规则型策略（正则/关键词）之外，TS 策略包（`otel-hook-strategies-ts`）提供本地安全小模型（Qwen3Guard-Stream-4B）驱动的审核能力：

| 策略 | 形态 | 说明 |
|------|------|------|
| `Qwen3GuardHook` | 标准 Hook | 全文审核，Safe / Controversial / Unsafe 三分类 + 置信度阈值拦截，fail-closed |
| `StreamGuard` | 三门流式防线 | 门1 输入审核（主模型零调用拦截）→ 门2 流式句子级 hold-back 增量审核 → 门3 终检发布门；拦截 = 零暴露 |

```typescript
import { createStreamGuard, runGuardedStream } from 'otel-hook-strategies'

const guard = createStreamGuard({ endpoint: 'http://localhost:8000', sessionId, userId, parentContext })

const g = await guard.startTurn(messages)                 // 门1
if (g.blocked) return showNotice(g.reason)

const r = await runGuardedStream(                          // 门2+门3：包装任意 delta 流
  signal => myLlmStream(signal), guard,
  { onRelease: chunk => render(chunk) },                   // 只回调过检文本
)
if (r.outcome === 'blocked') rollbackTurn(r.blocked)       // 违规原文在 r.blocked.blockedText
```

与 agent 框架完全解耦：后端可替换（`GuardBackend` 接口）、参数可配置（`streamGuardFromEnv` 支持环境变量）、每次检测发射 Langfuse GUARDRAIL span。详见 [StreamGuard 使用指南](docs/stream-guard.md)，攻防验证见 [19 家族红队报告](docs/Safetymind_Pi_Attack_Defense_Report.md)。
