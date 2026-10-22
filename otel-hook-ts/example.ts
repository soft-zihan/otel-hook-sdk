/**
 * Example: Using otel-hook with a simple agent
 */

import {
  setupTracing,
  getTracer,
  SpanNames,
  HookContext,
  HookPoint,
  HookResult,
  HookResultHelper,
  registerHook,
  runHooks,
} from './src/index';

// 1. Setup tracing
setupTracing({
  serviceName: 'example-agent',
  otlpEndpoint: 'http://localhost:4317',
  cache: true,
});

const tracer = getTracer();

// 2. Define hooks
const securityCheck = (ctx: HookContext): HookResult => {
  const args = ctx.attributes['tool.args'] || '';
  if (args.includes('rm -rf')) {
    return HookResultHelper.deny('dangerous command detected');
  }
  return HookResultHelper.allow();
};

const auditLog = (ctx: HookContext): HookResult => {
  console.log(`[AUDIT] ${ctx.spanName}: ${JSON.stringify(ctx.attributes)}`);
  return HookResultHelper.allow();
};

// 3. Register hooks
registerHook(SpanNames.TOOL_CALL, securityCheck, 'security', 10);
registerHook(SpanNames.TOOL_CALL, auditLog, 'audit', 1000);

// 4. Use in agent code
async function executeTool(name: string, args: string) {
  const span = tracer.startSpan(SpanNames.TOOL_CALL);
  span.setAttribute('tool.name', name);
  span.setAttribute('tool.args', args);

  try {
    // Run hooks
    const ctx: HookContext = {
      spanName: SpanNames.TOOL_CALL,
      attributes: {
        'tool.name': name,
        'tool.args': args,
      },
      hookPoint: HookPoint.PRE,
    };

    const result = await runHooks(ctx);

    if (!result.allowed) {
      console.log(`Hook blocked: ${result.reason}`);
      span.setStatus({ code: 2, message: result.reason });
      return;
    }

    // Execute tool
    console.log(`Executing: ${name} ${args}`);
    span.setStatus({ code: 0 });
  } finally {
    span.end();
  }
}

// Test
(async () => {
  console.log('Test 1: Normal command');
  await executeTool('bash', 'ls -la');

  console.log('\nTest 2: Dangerous command');
  await executeTool('bash', 'rm -rf /');

  console.log('\nTest 3: Another normal command');
  await executeTool('bash', 'cat file.txt');
})();
