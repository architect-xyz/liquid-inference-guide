# Hermes Agent

Hermes Agent is a terminal agent from Nous Research. The source recommends the Liquid Inference plugin, which adds the exchange as a model provider. The plugin holds the exchange URL and the request headers. The key stays in the environment.

Source: derived from the Liquid Inference connection guide for Hermes Agent; config keys were not re-run by the authors of this repo. The source states the setup is tested with Hermes Agent 0.21.6.

## Prerequisites

- A workspace with a balance and a `spend` key.
- macOS or Linux, with `git` and `curl`. On Linux, install `libatomic1` (Debian, Ubuntu) or `libatomic` (Fedora, RHEL) first.
- A model with a context window of 64,000 tokens or more.

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/818c13be1dc4fd28987e1e881a9408224afd4535/scripts/install.sh | bash -s -- --commit 818c13be1dc4fd28987e1e881a9408224afd4535 --skip-setup
export PATH="$HOME/.local/bin:$PATH"
```

## Configure

Install one commit of the plugin and select the model. Each `hermes config set` changes one setting in `~/.hermes/config.yaml`.

```bash
hermes plugins install architect-xyz/hermes-liquid-inference --ref a7ce8ae3d46253b51c70922c734e3a71ee6bad37 --enable &&
hermes config set model.provider liquid &&
hermes config set model.default "liquid.auto" &&
hermes config set model.default_headers.x-liquid-cap-usd 0.50
```

The plugin sends `X-Title: Hermes Agent` and `x-liquid-cap-usd: 1.00` with each model request. The last command replaces that cap. Do not set `X-Title` in `model.default_headers`, because the receipt then loses the client label.

The plugin uses the URL of the production exchange. Set `LIQUID_BASE_URL` only for a different exchange.

For `liquid.auto`, Hermes Agent assumes a 256,000-token window. Set `model.context_length` to use another value.

## Run

```bash
hermes
```

Use `/model` in a session to change the model.

## Verify

Send a short request that asks for the word `ready`. Open Credits, then Receipts. The client label is `Hermes Agent`. Read the charge from the receipt, not from the harness.

## Cap per request

```bash
hermes config set model.default_headers.x-liquid-cap-usd 0.25
```

Hermes Agent stores the value as a number, so `0.50` becomes `0.5`. The exchange reads both as the same value. A task sends several requests, and the session title request carries the same cap. To limit the total, set a spending limit on the key.

Two behaviours that cause refused requests (no charge):

- Hermes Agent sends a reasoning effort. If no offer accepts one, the exchange returns `400 unsupported_parameter`, and Hermes retries without it.
- The session title request asks for a JSON schema. If no offer accepts it, the same happens. To stop the title request: `hermes config set auxiliary.title_generation.enabled false`.

## Manual configuration (no plugin)

```bash
hermes config set model.provider custom &&
hermes config set model.base_url "https://router.inference.ai.exchange/v1" &&
hermes config set model.key_env LIQUID_API_KEY &&
hermes config set model.default "liquid.auto" &&
hermes config set model.context_length 128000 &&
hermes config set model.default_headers.X-Title "Hermes Agent" &&
hermes config set model.default_headers.x-liquid-cap-usd 0.50
```

Keep `model.key_env` as `LIQUID_API_KEY`, without `$`. Do not put the key in the config or in a header.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `hermes` is not on `PATH`. | Add `~/.local/bin` to `PATH`. |
| `Unknown provider 'liquid'` | The plugin is not installed. Run the plugin install command again. |
| The release is too old. | Update Hermes Agent to 0.21.6 or later. |
| The context window is below the limit. | Select a model with 64,000 tokens or more. |
| A command waits and prints nothing. | Check `LIQUID_BASE_URL` if you set it. Hermes waits long when it cannot connect. |
| `no_eligible_offer` in `~/.hermes/logs/errors.log` | Read `eligibility.excluded` in the error. |
| `401` | `LIQUID_API_KEY` is unset, invalid or expired. |
| `403` | Check the key's `spend` scope, address restriction and preset rules. |
| `402` | Add credit, or check the key's spend limit. |
| `404` | Keep `/v1` at the end of the base URL. |
| `cap_exceeds_buyer_cap` | Raise the request cap or pick a cheaper model. |

## Next

- [GitHub Copilot CLI](copilot-cli.md)
- [Harness index](README.md)
