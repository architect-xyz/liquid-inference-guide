---
name: liquid-agent-sdk
description: Run the Claude Agent SDK, OpenAI Agents SDK or Vercel AI SDK against Liquid Inference with caps and correct settings, in Python or TypeScript. Use when the user is building their own agent and wants it to buy inference from the exchange.
---

# Agent SDKs on Liquid Inference

Full examples: `docs/agent-sdks/` in `https://github.com/architect-xyz/liquid-inference-guide`. Key always from `LIQUID_API_KEY`.

## Claude Agent SDK (Python `claude-agent-sdk`, TypeScript `@anthropic-ai/claude-agent-sdk`)

`query()` starts the Claude Code CLI as a subprocess. Put these in `env`:

- `ANTHROPIC_AUTH_TOKEN` = the key; `ANTHROPIC_BASE_URL` = `https://router.inference.ai.exchange` (no `/v1`).
- `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` all set to `cc.anthropic/liquid.auto`. An unset one asks for a `claude-*` model and fails.
- `ANTHROPIC_API_KEY` = `""` so an Anthropic key in the environment is not sent.
- `ANTHROPIC_CUSTOM_HEADERS` = `x-liquid-cap-usd: 0.50` (newline-separate more headers).
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS` = `8192`.
- `setting_sources=[]` / `settingSources: []` so settings files cannot override `env`.
- TypeScript: keep `...process.env` first in `env`; it replaces the environment.

`total_cost_usd` is an estimate; read the receipt.

## OpenAI Agents SDK (`openai-agents`, `@openai/agents`)

Use the Responses adapter with an OpenAI client whose `base_url` is `https://router.inference.ai.exchange/v1`.

- Python: `OpenAIResponsesModel(model="liquid.auto", openai_client=client)`, `ModelSettings(max_tokens=1024, store=False, extra_body={"exchange": {"cap_usd": 0.50}})`, `RunConfig(tracing_disabled=True)`.
- TypeScript: `new OpenAIResponsesModel(client, 'liquid.auto')`, `modelSettings: { maxTokens: 1024, store: false, providerData: { extra_body: { exchange: { cap_usd: 0.5 } } } }`, `new Runner({ tracingDisabled: true })`.
- No `previous_response_id`, `conversation` or background mode; keep history in the app (`result.to_input_list()` / `result.history`).
- Hosted tools (file search, code interpreter) are unavailable; use local function tools.
- Chat Completions alternative: `OpenAIChatCompletionsModel`; `providerData` is sent directly, with no `extra_body` wrapper.

## Vercel AI SDK (`ai`, `@ai-sdk/openai-compatible`)

```typescript
const liquid = createOpenAICompatible({
  name: 'liquid',
  baseURL: 'https://router.inference.ai.exchange/v1',
  apiKey: process.env.LIQUID_API_KEY,
  headers: { 'x-liquid-cap-usd': '1.00' },
})
const model = liquid('liquid.auto')
```

## Spend control

The cap is per request. For total spend, give the agent its own key with a spending limit.
