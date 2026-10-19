# Harness guides

A harness is a coding agent or editor that you point at the Liquid Inference exchange with a key. The exchange auctions each request, fixes a price cap before the first token, and charges for the tokens used.

Every guide uses these values:

| Value | Setting |
| --- | --- |
| Origin | `https://router.inference.ai.exchange` |
| Model | `liquid.auto` |
| Key | A `spend` key, exported as `LIQUID_API_KEY` |
| Cap | `0.50` USD for one request, where the harness can send a header |

Never write the key into a config file. Each guide reads it from the environment.

The guides are derived from the Liquid Inference connection guides. The authors of this repo did not re-run the config keys. Each guide says what its source states.

## Index

| Harness | Wire format | Config file or method | Cap mechanism | Guide |
| --- | --- | --- | --- | --- |
| Claude Code | Anthropic Messages | Environment variables, or `.claude/settings.json` | `ANTHROPIC_CUSTOM_HEADERS` | [claude-code.md](claude-code.md) |
| Codex | OpenAI Responses | `~/.codex/liquid.config.toml` | `http_headers` in the provider table | [codex.md](codex.md) |
| Cursor (editor) | Chat Completions | Settings screen | None. `liquid.auto` has its own cap | [cursor.md](cursor.md) |
| Cline | Chat Completions | VS Code settings, or `~/.cline/data/settings/providers.json` | Custom header `x-liquid-cap-usd` | [cline.md](cline.md) |
| OpenCode | Chat Completions | `~/.config/opencode/opencode.json` | `headers` in the provider or model | [opencode.md](opencode.md) |
| Goose | Chat Completions | `~/.config/goose/custom_providers/custom_liquid.json` | `headers` in the provider file | [goose.md](goose.md) |
| Pi | Chat Completions | `~/.pi/agent/models.json` | `headers` in the provider | [pi.md](pi.md) |
| OpenHands | Chat Completions | SDK code, or `~/.openhands/agent_settings.json` | `extra_headers` | [openhands.md](openhands.md) |
| Hermes Agent | OpenAI-compatible | `~/.hermes/config.yaml` | `model.default_headers` | [hermes-agent.md](hermes-agent.md) |
| GitHub Copilot CLI | Chat Completions | Environment variables | `COPILOT_PROVIDER_HEADERS` | [copilot-cli.md](copilot-cli.md) |

## Concepts that apply to every guide

- The cap limits one request. A task can send many requests, so the cap does not limit the total. Set a spending limit on the key to limit the total.
- The exchange reads the cap from the `x-liquid-cap-usd` header. If the worst-case charge of a request is above the cap, the exchange refuses the request.
- Read the charge from the receipt, not from the harness cost display. The harness does not know the exchange charge.
- The `X-Title` header names the client on the receipt.
- The optional Liquid CLI (`liquid connect <harness>`) prints a setup with your model filled in. You do not need it.
