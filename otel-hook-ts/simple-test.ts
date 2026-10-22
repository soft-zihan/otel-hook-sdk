/**
 * Simple test without OTLP backend
 */

import {
  HookContext,
  HookPoint,
  HookResultHelper,
  registerHook,
  runHooks,
  SpanNames,
} from './src/index';

// Define hooks
const securityCheck = (ctx: HookContext) => {
  const args = ctx.attributes['tool.args'] || '';
  if (args.includes('rm -rf')) {
    return HookResultHelper.deny('dangerous command detected');
  }
  return HookResultHelper.allow();
};

const auditLog = (ctx: HookContext) => {
  console.log(`[AUDIT] ${ctx.spanName}: ${JSON.stringify(ctx.attributes)}`);
  return HookResultHelper.allow();
};

// Register hooks
registerHook(SpanNames.TOOL_CALL, securityCheck, 'security', 10);
registerHook(SpanNames.TOOL_CALL, auditLog, 'audit', 1000);

// Test
async function test() {
  console.log('Test 1: Normal command');
  const ctx1: HookContext = {
    spanName: SpanNames.TOOL_CALL,
    attributes: { 'tool.args': 'ls -la' },
    hookPoint: HookPoint.PRE,
  };
  const result1 = await runHooks(ctx1);
  console.log(`Result: allowed=${result1.allowed}`);

  console.log('\nTest 2: Dangerous command');
  const ctx2: HookContext = {
    spanName: SpanNames.TOOL_CALL,
    attributes: { 'tool.args': 'rm -rf /' },
    hookPoint: HookPoint.PRE,
  };
  const result2 = await runHooks(ctx2);
  console.log(`Result: allowed=${result2.allowed}, reason=${result2.reason}`);

  console.log('\nTest 3: Another normal command');
  const ctx3: HookContext = {
    spanName: SpanNames.TOOL_CALL,
    attributes: { 'tool.args': 'cat file.txt' },
    hookPoint: HookPoint.PRE,
  };
  const result3 = await runHooks(ctx3);
  console.log(`Result: allowed=${result3.allowed}`);
}

test().catch(console.error);
