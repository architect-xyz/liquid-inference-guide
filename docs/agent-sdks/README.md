# Agent SDKs

Libraries that run an agent loop inside your own application.

| SDK | Languages | Wire format | Cap mechanism | Guide |
| --- | --- | --- | --- | --- |
| Claude Agent SDK | Python, TypeScript | Anthropic Messages | `ANTHROPIC_CUSTOM_HEADERS` | [claude-agent-sdk.md](claude-agent-sdk.md) |
| OpenAI Agents SDK | Python, TypeScript | OpenAI Responses | `exchange` block in `extra_body` | [openai-agents-sdk.md](openai-agents-sdk.md) |
| Vercel AI SDK | TypeScript | OpenAI Chat Completions | `x-liquid-cap-usd` header | [vercel-ai-sdk.md](vercel-ai-sdk.md) |

Every guide uses the same two inputs: the key in `LIQUID_API_KEY` and the base URL `https://router.inference.ai.exchange`. Read the charge from the receipt, not from the SDK's own cost display.
