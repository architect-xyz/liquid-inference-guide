# Claude Code

Claude Code is Anthropic's terminal agent. It uses the Anthropic Messages format and reads its endpoint from environment variables.

Source: derived from the Liquid Inference connection guide for Claude Code; config keys were not re-run by the authors of this repo.

## Prerequisites

- A workspace with a balance and a `spend` key.
- The key exported in the shell that starts Claude Code:

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install

```bash
# native installer (macOS, Linux, WSL)
curl -fsSL https://claude.ai/install.sh | bash

# or with npm
npm install -g @anthropic-ai/claude-code
```

## Configure

Set `LIQUID_API_KEY` before this block. If a profile sets the key on a later line, the token is empty and each request fails with `401`.

```bash
export ANTHROPIC_BASE_URL="https://router.inference.ai.exchange"
export ANTHROPIC_AUTH_TOKEN="$LIQUID_API_KEY"
export ANTHROPIC_MODEL="cc.anthropic/liquid.auto"
export ANTHROPIC_DEFAULT_OPUS_MODEL="cc.anthropic/liquid.auto"
export ANTHROPIC_DEFAULT_SONNET_MODEL="cc.anthropic/liquid.auto"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="cc.anthropic/liquid.auto"
export CLAUDE_CODE_SUBAGENT_MODEL="cc.anthropic/liquid.auto"
export CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY="1"
export CLAUDE_CODE_MAX_OUTPUT_TOKENS="8192"
export CLAUDE_CODE_AUTO_MODE_SERVER="0"
export CLAUDE_CODE_ATTRIBUTION_HEADER="0"
unset ANTHROPIC_API_KEY
```

| Variable | Why |
| --- | --- |
| `ANTHROPIC_BASE_URL` | The origin with no `/v1`. The client adds `/v1/messages`. |
| `ANTHROPIC_AUTH_TOKEN` | Your key as a bearer token. Use this, not `ANTHROPIC_API_KEY`, which has priority. |
| model variables | The `cc.anthropic/` prefix is required. Claude Code drops model ids without "claude" or "anthropic". |
| `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` | Loads the exchange model list into the picker. |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | Claude Code asks for 32,000 output tokens at high effort. A lower value gives a lower cap per request. |
| `CLAUDE_CODE_AUTO_MODE_SERVER` | Stops a notice about auto mode classifier requests. |
| `CLAUDE_CODE_ATTRIBUTION_HEADER` | Keeps Claude Code's version block out of the prompt, so you do not pay for its tokens. |

The variables apply only to the process you start with them. You do not need to sign out of Claude Code. To keep them out of your normal shell, put them in a wrapper function.

To use a project file, put the same variables in the `env` object of `.claude/settings.local.json`. That file holds the key in plain text, so keep it out of version control. The source recipe does not show this file's exact contents.

## Run

```bash
claude
```

## Verify

1. Run `/status`. The API base URL and model must be the values you set.
2. Send one message.
3. Open the receipt in the console (Overview or Credits page), or fetch it by job id.
4. Read the charge from the receipt, not from the harness cost display.

## Cap per request

Claude Code cannot send the `exchange` object. Send the cap as a header:

```bash
export ANTHROPIC_CUSTOM_HEADERS="x-liquid-cap-usd: 0.50"
```

Put a newline between two headers. The header applies to every request, including subagents. To limit the total, set a spending limit on the key.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The picker shows only built-in models. | `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY` is not `1`, or the shell started before you set it. |
| Requests still go to Anthropic. | `ANTHROPIC_API_KEY` has priority. Run `unset ANTHROPIC_API_KEY` and restart. |
| `401` | `echo $ANTHROPIC_AUTH_TOKEN`. An empty value means the key was set too late. Also check that the key has the `spend` scope. |
| `400 auto_requires_price_bound` | The router model has no cap and nothing sets a bound. Set the header above. |
| `400 invalid_header` | A header in `ANTHROPIC_CUSTOM_HEADERS` cannot be parsed. |
| `model_not_found` | The name is not on the book, or the `cc.anthropic/` prefix is missing. Check `GET /v1/models`. |
| Answers stop with `stop_reason: "max_tokens"` | The offers allow less output than Claude Code asked for. Choose a model whose offers allow more. |
| `402 insufficient_balance` | The balance cannot cover the cap. Add funds. |

## Next

- [Codex](codex.md)
- [Harness index](README.md)
