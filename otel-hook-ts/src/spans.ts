/**
 * Span definitions for agent monitoring.
 * 
 * Defines all span names and attributes used in the system.
 */

export const SpanNames = {
  AGENT_SESSION: 'agent.session',
  
  // LLM related
  LLM: 'llm',
  PROMPT_BUILD: 'llm.prompt_build',
  MODEL_CALL: 'llm.model_call',
  RESPONSE_PARSE: 'llm.response_parse',
  
  // Tool calls
  TOOL_CALL: 'tool.call',
  TOOL_INPUT: 'tool.input',
  TOOL_OUTPUT: 'tool.output',
  
  // Chain calls
  CHAIN: 'chain',
  CHAIN_STEP: 'chain.step',
} as const;

export const SpanAttributes = {
  // Session attributes
  SESSION_ID: 'session.id',
  USER_ID: 'user.id',
  AGENT_NAME: 'agent.name',
  AGENT_VERSION: 'agent.version',
  
  // LLM attributes
  LLM_MODEL: 'llm.model',
  LLM_PROVIDER: 'llm.provider',
  LLM_INPUT_MESSAGES: 'llm.input.messages',
  LLM_OUTPUT_TEXT: 'llm.output.text',
  MODEL_PROVIDER: 'llm.provider',
  MODEL_OUTPUT_TEXT: 'llm.output.text',
  LLM_TEMPERATURE: 'llm.temperature',
  LLM_MAX_TOKENS: 'llm.max_tokens',
  LLM_PROMPT_TOKENS: 'llm.prompt_tokens',
  LLM_COMPLETION_TOKENS: 'llm.completion_tokens',
  LLM_TOTAL_TOKENS: 'llm.total_tokens',
  LLM_COST: 'llm.cost',
  LLM_LATENCY_MS: 'llm.latency_ms',
  
  // Tool attributes
  TOOL_NAME: 'tool.name',
  TOOL_ARGS: 'tool.args',
  TOOL_RESULT: 'tool.result',
  TOOL_SUCCESS: 'tool.success',
  
  // Chain attributes
  CHAIN_NAME: 'chain.name',
  CHAIN_STEP_INDEX: 'chain.step_index',
  CHAIN_STEP_NAME: 'chain.step_name',
  
  // Hook attributes
  HOOK_NAME: 'hook.name',
  HOOK_ALLOWED: 'hook.allowed',
  HOOK_REASON: 'hook.reason',
  HOOK_DURATION_MS: 'hook.duration_ms',
  HOOK_BLOCKED: 'hook.blocked',
  HOOK_POINT: 'hook.point',
  HOOK_PRIORITY: 'hook.priority',
  
  // Error attributes
  ERROR_TYPE: 'error.type',
  ERROR_MESSAGE: 'error.message',
} as const;
