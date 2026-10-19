# Codex

Codex is OpenAI's terminal agent. It uses the OpenAI Responses API and reads providers from config files. You add the exchange as a provider in a Codex profile.

Source: derived from the Liquid Inference connection guide for Codex; config keys were not re-run by the authors of this repo.

## Prerequisites

- A workspace with a balance and a `spend` key.
- Codex 0.95 or later. From 0.95, Codex speaks only the Responses API.
- The key exported in your shell:

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install

```bash
npm install -g @openai/codex@latest
codex --version
```

## Configure

Write `~/.codex/liquid.config.toml`. A profile file is applied on top of `~/.codex/config.toml` when you pass `--profile liquid`.

```toml
model = "liquid.auto"
model_provider = "liquid"
web_search = "disabled"
suppress_unstable_features_warning = true

[features]
api_key_model_discovery = true

[model_providers.liquid]
name = "Liquid Inference"
base_url = "https://router.inference.ai.exchange/v1"
env_key = "LIQUID_API_KEY"
model_catalog_url = "https://router.inference.ai.exchange/v1/codex/models"
http_headers = { "x-liquid-cap-usd" = "0.50" }
```

| Setting | Why |
| --- | --- |
| `web_search = "disabled"` | Codex web search runs on OpenAI servers. Without this line, the exchange removes the tool from each request. |
| `api_key_model_discovery` | Makes Codex read the model list from `model_catalog_url`. |
| `base_url` | Ends in `/v1`, because Codex appends `/responses`. |
| `env_key` | Codex reads the key from this variable, so the file holds no key. |

Do not add `wire_api`. Codex 0.95 removed `wire_api = "chat"`.

To use the exchange without `--profile`, for example in the VS Code extension, put the same settings in `~/.codex/config.toml`. Put top-level lines above the first `[section]` header. If the file already has a `[features]` table, add the line to that table.

## Run

```bash
codex --profile liquid
```

To pick a model for one session, add `--model <name>`. Inside a session, `/model` lists the models from the exchange.

## Verify

Send one request, for example with `codex exec`, or in a session. Then open Receipts on the Credits page. The request shows Codex as the client. Read the charge from the receipt, not from the harness.

## Cap per request

The cap is the `x-liquid-cap-usd` entry in `http_headers` above. It applies to each request Codex sends. Other header names the source lists: `x-liquid-ttft-ms`, `x-liquid-profile`, `x-liquid-policy`, `x-liquid-retention`, `x-liquid-rules`. To limit the total, set a spending limit on the key.

Codex sends no output limit. The exchange uses 32,768 tokens and lowers it to fit the offers.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `Missing environment variable: LIQUID_API_KEY` | Export the key in this shell and start Codex again. |
| `401 Unauthorized` | The key is wrong, revoked or expired. Check that it has the `spend` scope. |
| `404 ... is not provided by Liquid Inference` | `model_not_found`. Pick a name from `/model` or `GET /v1/models`. |
| `402 Payment Required` | `insufficient_balance`. Add funds. |
| `auto_requires_price_bound` | A router model with no cap. Keep the `http_headers` line. |
| `unsupported_parameter` with `tools[...]` | Codex sent a hosted tool the exchange cannot run. Turn off the Codex feature that adds it. |
| Fallback metadata notice, or `/model` lists OpenAI models | `api_key_model_discovery = true` is missing from `[features]`, or the model is not in the exchange list. |
| `wire_api = "chat"` is no longer supported | Delete the `wire_api` line. |
| Codex uses your usual model and no request reaches the exchange | The name after `--profile` matches no file. Run `ls ~/.codex/*.config.toml`. |
| `Incomplete response ... max_output_tokens` | The answer hit the limit. Use a model whose offers allow longer answers, or raise the cap. |

Hosted tools (web search, file search, code interpreter) and stored responses (`previous_response_id`, `conversation`, `background: true`) are not supported.

## Next

- [Claude Code](claude-code.md)
- [Harness index](README.md)
