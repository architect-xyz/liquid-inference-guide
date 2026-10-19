---
name: liquid-connect-harness
description: Configure a coding agent harness (Claude Code, Codex, Cursor, Cline, OpenCode, Goose, Pi, OpenHands, Hermes Agent, Copilot CLI) to use Liquid Inference. Use when the user wants to run one of these tools on the exchange.
---

# Connect a coding harness to Liquid Inference

Detailed per-harness guides live in `docs/harnesses/` of the liquid-inference-guide repository (`https://github.com/architect-xyz/liquid-inference-guide`). Read the one for the user's harness before editing config; the config keys change between releases.

## Universal inputs

- Key from the environment: `LIQUID_API_KEY` (a `spend` key). Never write it into a committed file.
- OpenAI-format base URL `https://router.inference.ai.exchange/v1`; Anthropic-format base URL `https://router.inference.ai.exchange`.
- Model: `liquid.auto` (or a name from `GET /v1/models`).
- Cap each request with the header `x-liquid-cap-usd: 0.50` where the harness allows custom headers.

## Which wire format

| Harness | Format | Guide |
| --- | --- | --- |
| Claude Code | Anthropic Messages | `docs/harnesses/claude-code.md` |
| Codex | OpenAI Responses | `docs/harnesses/codex.md` |
| Cursor | Chat Completions | `docs/harnesses/cursor.md` |
| Cline | Chat Completions | `docs/harnesses/cline.md` |
| OpenCode | Chat Completions | `docs/harnesses/opencode.md` |
| Goose | Chat Completions | `docs/harnesses/goose.md` |
| Pi | Chat Completions | `docs/harnesses/pi.md` |
| OpenHands | Chat Completions (SDK and CLI) | `docs/harnesses/openhands.md` |
| Hermes Agent | OpenAI-compatible | `docs/harnesses/hermes-agent.md` |
| Copilot CLI | see guide | `docs/harnesses/copilot-cli.md` |

## Claude Code notes

Models go with a `cc.anthropic/` prefix (for example `cc.anthropic/liquid.auto`). Claude Code asks for different models per task type, so set the main, Haiku/background and subagent model variables to the same name or the unset ones request `claude-*` models the exchange does not list.

## Verify

After the first run, open the console receipts. The receipt names the client. If nothing appears, requests are going elsewhere; look for settings files that override base URL or key.

## Be honest about status

The guides record what their source verified. If a step fails, check the harness's own docs; do not invent config keys.
