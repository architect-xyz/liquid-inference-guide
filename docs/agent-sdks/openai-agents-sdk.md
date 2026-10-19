# OpenAI Agents SDK

The OpenAI Agents SDK runs an agent loop in your Python or TypeScript application. It sends each model request to the exchange through the Responses API.

Source: derived from the Liquid Inference connection guide. A Python canary exists upstream; the TypeScript example has no canary. The authors of this repository did not re-run either example.

## Before you start

- A workspace with a balance and a `spend` key.
- `export LIQUID_API_KEY=sk-liquid-...` in the shell that starts the app.

## 1. Install

```bash
# Python 3.10 or later
pip install openai-agents

# TypeScript, Node 22 or later
npm install @openai/agents openai zod
```

## 2. Create the agent

**Python**

```python
import asyncio
import os

from agents import Agent, ModelSettings, OpenAIResponsesModel, RunConfig, Runner
from openai import AsyncOpenAI


def create_agent() -> Agent:
    client = AsyncOpenAI(
        base_url="https://router.inference.ai.exchange/v1",
        api_key=os.environ["LIQUID_API_KEY"],
    )
    return Agent(
        name="Assistant",
        model=OpenAIResponsesModel(model="liquid.auto", openai_client=client),
        model_settings=ModelSettings(
            max_tokens=1024,
            store=False,
            extra_body={"exchange": {"cap_usd": 0.50}},
        ),
    )


async def main() -> None:
    result = await Runner.run(
        create_agent(),
        "Say hello.",
        run_config=RunConfig(tracing_disabled=True),
    )
    print(result.final_output)


if __name__ == "__main__":
    asyncio.run(main())
```

**TypeScript**

```typescript
import { Agent, OpenAIResponsesModel, Runner } from '@openai/agents'
import OpenAI from 'openai'

const client = new OpenAI({
  baseURL: 'https://router.inference.ai.exchange/v1',
  apiKey: process.env.LIQUID_API_KEY,
})

const agent = new Agent({
  name: 'Assistant',
  model: new OpenAIResponsesModel(client, 'liquid.auto'),
  modelSettings: {
    maxTokens: 1024,
    store: false,
    providerData: { extra_body: { exchange: { cap_usd: 0.5 } } },
  },
})

const runner = new Runner({ tracingDisabled: true })
const result = await runner.run(agent, 'Say hello.')
console.log(result.finalOutput)
```

The base URL ends in `/v1`. Tracing is off because an exchange key cannot send traces to OpenAI. `store=False` is required because the exchange keeps no response state. The output limit is 1,024 tokens per request. Choose a model, router model or preset from `GET /v1/models`.

## Purchasing rules

Python puts the `exchange` object in `ModelSettings.extra_body`. TypeScript puts it in `modelSettings.providerData.extra_body`. The example caps each request at $0.50. A run can send several requests, each with its own cap. If no offer fits, the exchange refuses the request; it does not shrink the output limit. For a total limit, use a separate key with a spend limit.

## Local function tools

Functions with `@function_tool` (Python) or `tool()` (TypeScript) run in your app. The exchange forwards their definitions and returns the model's tool calls; the SDK runs each function and sends the result in the next request. OpenAI-hosted tools (file search, code interpreter) are not available. Hosted web search definitions are dropped; other hosted tools are refused by name.

## Continue a conversation

Keep history in your app. Do not use `previous_response_id`, `conversation` or background mode; the exchange refuses them. The Responses WebSocket transport is not supported.

```python
history = result.to_input_list()
history.append({"role": "user", "content": "Explain that answer."})
result = await Runner.run(agent, history, run_config=RunConfig(tracing_disabled=True))
```

```typescript
const history = [...result.history, { role: 'user' as const, content: 'Explain that answer.' }]
const next = await runner.run(agent, history)
```

## Chat Completions alternative

```python
from agents import OpenAIChatCompletionsModel

model = OpenAIChatCompletionsModel(model="liquid.auto", openai_client=client)
```

```typescript
import { OpenAIChatCompletionsModel } from '@openai/agents'

const model = new OpenAIChatCompletionsModel(client, 'liquid.auto')
const modelSettings = {
  maxTokens: 1024,
  store: false,
  providerData: { exchange: { cap_usd: 0.5 } },
}
```

The Chat Completions adapter sends `providerData` directly, without the `extra_body` wrapper.

## Verify and troubleshoot

The receipt shows **OpenAI Agents SDK** as the client. Read the charge from the receipt, not from SDK token usage.

| Symptom | Fix |
| --- | --- |
| `401` | Check that `LIQUID_API_KEY` is set and has the `spend` scope. |
| `model_not_found` | Use a name from `GET /v1/models`. |
| Request exceeds the cap | Lower the output limit or raise the cap. |
| `unsupported_parameter` for response state | Send full history, no continuation id. |
| Hosted tool refused | Replace it with a local function tool. |
| Insufficient funds | Add funds to the workspace. |
