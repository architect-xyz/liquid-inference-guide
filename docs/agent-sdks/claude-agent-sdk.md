# Claude Agent SDK

The Claude Agent SDK is Claude Code as a Python or TypeScript library. A `query()` call starts the Claude Code CLI as a subprocess with the environment that you give it. To send the agent to the exchange, put the exchange origin, your key and a cost cap in that environment. Tools, hooks, subagents and sessions work as they do with Anthropic.

Source: derived from the Liquid Inference connection guide for the Claude Agent SDK. A Python canary exists upstream; the TypeScript example has no canary. The authors of this repository did not re-run either example.

For direct Messages API calls, use the Anthropic SDK instead. See [OpenAI and Anthropic SDKs](../getting-started.md#send-a-request).

## Before you start

- A workspace with a balance and a `spend` key. See [getting started](../getting-started.md).
- The key exported in the shell that runs the agent, so it never appears in code:

  ```bash
  export LIQUID_API_KEY=sk-liquid-...
  ```

## 1. Install

The package includes the Claude Code CLI. Do not install Claude Code separately.

```bash
# Python 3.10 or newer
pip install claude-agent-sdk

# TypeScript, Node 18 or newer
npm install @anthropic-ai/claude-agent-sdk
```

## 2. Point the agent at the exchange

Pass these options to every `query()` call.

**Python**

```python
import asyncio
import os

from claude_agent_sdk import ClaudeAgentOptions, query

MODEL = "cc.anthropic/liquid.auto"

options = ClaudeAgentOptions(
    env={
        "ANTHROPIC_AUTH_TOKEN": os.environ["LIQUID_API_KEY"],
        "ANTHROPIC_BASE_URL": "https://router.inference.ai.exchange",
        "ANTHROPIC_MODEL": MODEL,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": MODEL,
        "CLAUDE_CODE_SUBAGENT_MODEL": MODEL,
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_CUSTOM_HEADERS": "x-liquid-cap-usd: 0.50",
        "CLAUDE_CODE_ATTRIBUTION_HEADER": "0",
        "CLAUDE_CODE_AUTO_MODE_SERVER": "0",
        "CLAUDE_CODE_MAX_OUTPUT_TOKENS": "8192",
    },
    setting_sources=[],
    allowed_tools=["Read", "Glob"],
)


async def main():
    async for message in query(prompt="List the files here.", options=options):
        print(message)


asyncio.run(main())
```

**TypeScript** (save as `agent.mts`)

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk'

const model = 'cc.anthropic/liquid.auto'

const options = {
  env: {
    ...process.env,
    ANTHROPIC_AUTH_TOKEN: process.env.LIQUID_API_KEY,
    ANTHROPIC_BASE_URL: 'https://router.inference.ai.exchange',
    ANTHROPIC_MODEL: model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
    CLAUDE_CODE_SUBAGENT_MODEL: model,
    ANTHROPIC_API_KEY: '',
    ANTHROPIC_CUSTOM_HEADERS: 'x-liquid-cap-usd: 0.50',
    CLAUDE_CODE_ATTRIBUTION_HEADER: '0',
    CLAUDE_CODE_AUTO_MODE_SERVER: '0',
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: '8192',
  },
  settingSources: [],
  allowedTools: ['Read', 'Glob'],
}

for await (const message of query({ prompt: 'List the files here.', options })) {
  console.log(message)
}
```

| Setting | Why |
| --- | --- |
| `ANTHROPIC_AUTH_TOKEN` | Your key, sent as a bearer token. The base URL has no `/v1`, because the CLI adds `/v1/messages`. |
| `ANTHROPIC_API_KEY` set to an empty string | Keeps an Anthropic key in the inherited environment from reaching the exchange. |
| `ANTHROPIC_CUSTOM_HEADERS` | Caps each request at $0.50. |
| `setting_sources=[]` / `settingSources: []` | Stops the CLI from loading `~/.claude/settings.json` and project settings. An `env` block there would replace your values. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | At high effort the CLI asks for 32,000 output tokens. An offer with a lower limit is refused. This value also keeps each cap small. |

In TypeScript, `env` replaces the subprocess environment, so keep `...process.env` first. In Python, the SDK adds `env` to the inherited environment.

`setting_sources=[]` also stops the CLI from loading `CLAUDE.md`, skills and hooks from settings. To load one project, pass `["project"]` and make sure its `.claude/settings.json` has no `env` block.

## 3. Run it

```bash
python agent.py
# or
npx tsx agent.mts
```

## 4. Verify

Each agent request is a job on the exchange. The receipt names the client as **Claude Agent SDK** and shows its cap. `total_cost_usd` in the SDK result is an estimate from token counts, not the exchange charge. Read the charge from the receipt.

## Choose a model

The exchange lists models to Claude Code with a `cc.anthropic/` prefix. Add `[1m]` if the live input window is one million tokens or more. The CLI asks for a different model per type of work, so set all three variables: `ANTHROPIC_MODEL` (main agent), `ANTHROPIC_DEFAULT_HAIKU_MODEL` (background work) and `CLAUDE_CODE_SUBAGENT_MODEL` (subagents). An unset variable asks for a `claude-*` model that the exchange does not list, and the request fails. The `model` option of `query()` sets only the main agent.

## Cap each request

The CLI builds the request body, so send purchasing rules as headers. Separate headers with a newline:

```python
"ANTHROPIC_CUSTOM_HEADERS": "x-liquid-cap-usd: 0.50\nx-liquid-policy: economy",
```

An agent sends many requests per `query()`, and each has its own cap. If the estimated charge is above the cap, the exchange refuses the request. An unparseable header returns `400 invalid_header`. To limit total spend, give the agent its own key with a spending limit.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Requests go to Anthropic or another gateway | An `env` block in a settings file is replacing your values. Pass `setting_sources=[]`. |
| `KeyError: 'LIQUID_API_KEY'` or `401` | The key is not exported in the process that runs the agent, or lacks the `spend` scope. |
| `model_not_found` | Name not on the book, missing `cc.anthropic/` prefix, or one of the three model variables is unset. |
| `400 invalid_header` | A rule in `ANTHROPIC_CUSTOM_HEADERS` cannot be parsed. |
| `stop_reason: "max_tokens"` | The offers' output limit is below the request. Lower `CLAUDE_CODE_MAX_OUTPUT_TOKENS`. |
| Refused for lack of funds | The balance cannot cover the cap. |

Custom tools made with `@tool` / `tool()` run in your process and need no exchange setting.
