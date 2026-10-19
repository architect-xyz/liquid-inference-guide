# GitHub Copilot CLI

The GitHub Copilot CLI is GitHub's terminal agent. It can send model requests to a provider you choose. It reads the settings from environment variables, so they apply only to the shell that starts it.

Source: derived from the Liquid Inference connection guide for GitHub Copilot CLI; config keys were not re-run by the authors of this repo.

## Prerequisites

- A workspace with a balance and a `spend` key.
- A model that supports tool calls and streaming. Copilot refuses a model without them.

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install

```bash
npm install -g @github/copilot
```

## Configure

Use the same shell for the commands below. Keep the `\n` literal: single quotes do that.

```bash
export COPILOT_MODEL="liquid.auto"
export COPILOT_PROVIDER_BASE_URL="https://router.inference.ai.exchange/v1"
export COPILOT_PROVIDER_API_KEY="$LIQUID_API_KEY"
export COPILOT_PROVIDER_HEADERS='X-Title: GitHub Copilot CLI\nx-liquid-cap-usd: 0.50'
export COPILOT_PROVIDER_MAX_OUTPUT_TOKENS="8192"
```

| Variable | Why |
| --- | --- |
| `COPILOT_PROVIDER_BASE_URL` | The origin with `/v1`. Copilot sends Chat Completions requests. |
| `COPILOT_PROVIDER_API_KEY` | The key Copilot sends as a bearer token. |
| `COPILOT_MODEL` | The model for each request. |
| `COPILOT_PROVIDER_HEADERS` | Headers for each request, separated by `\n`. Sent only to the exchange. |
| `COPILOT_PROVIDER_MAX_OUTPUT_TOKENS` | Without it, Copilot sends no limit, and each hold covers the model's full output limit. |

Copilot needs no GitHub sign-in for this provider. To stop it from contacting GitHub at all, also set `COPILOT_OFFLINE=true`.

## Run

```bash
copilot
```

## Verify

Send a short request that asks for the word `ready`. Open Credits, then Receipts. The client label is `GitHub Copilot CLI`. Keep the `X-Title` header: without it, the receipt shows the OpenAI SDK as the client. Read the charge from the receipt, not from the harness.

## Cap per request

Change the `x-liquid-cap-usd` value in `COPILOT_PROVIDER_HEADERS`. A task can send several requests, so the cap does not limit the total. Set a spending limit on the key.

Copilot sends `temperature`, `top_p`, `frequency_penalty` and `presence_penalty`. The exchange sends the request only to an offer that accepts `top_p` and both penalties. If none does, the exchange refuses the request with no charge.

A refused request costs nothing. Copilot shows `400` and `402` at once. It retries `429` six times in about a minute, and `503` six times in about 20 seconds.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401` | `COPILOT_PROVIDER_API_KEY` is empty, invalid or expired. |
| `402` | Add credit, or raise the key's spend limit. |
| `404` | Keep `/v1` at the end of `COPILOT_PROVIDER_BASE_URL`. |
| `no_eligible_offer` | Read `eligibility.excluded` in the error. It names the rule each offer failed. |
| Receipt shows the OpenAI SDK | The `X-Title` header is missing from `COPILOT_PROVIDER_HEADERS`. |

## Next

- [Claude Code](claude-code.md)
- [Harness index](README.md)
