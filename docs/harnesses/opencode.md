# OpenCode

OpenCode is a terminal agent that accepts custom providers. The Liquid Inference provider uses the OpenAI-compatible adapter and `POST /v1/chat/completions`.

Source: derived from the Liquid Inference connection guide for OpenCode; config keys were not re-run by the authors of this repo.

## Prerequisites

- A workspace with a balance and a `spend` key.
- Node.js and `jq` (the merge script needs `jq`).
- The key exported in the shell that starts OpenCode:

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install

```bash
npm install -g opencode-ai
```

## Configure

OpenCode does not read `GET /v1/models`. The model list comes from the config file. The key stays an environment reference, `{env:LIQUID_API_KEY}`.

This script adds `liquid` to `~/.config/opencode/opencode.json`. It keeps your other providers, and stops and leaves the file unchanged if the file holds invalid JSON.

```bash
(
  set -eu
  d=~/.config/opencode
  mkdir -p "$d"
  touch "$d/opencode.json"
  tmp=$(mktemp "$d/opencode.json.XXXXXX")
  trap 'rm -f "$tmp"' EXIT
  jq --slurpfile current "$d/opencode.json" '
    . as $setup | ($current[0] // {}) |
    .provider.liquid = $setup.provider.liquid |
    ."$schema" //= $setup."$schema"
  ' <<'EOF2' > "$tmp"
{
  "$schema": "https://opencode.ai/config.json",
  "provider": {
    "liquid": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Liquid Inference",
      "options": {
        "baseURL": "https://router.inference.ai.exchange/v1",
        "apiKey": "{env:LIQUID_API_KEY}",
        "headers": {
          "X-Title": "OpenCode",
          "x-liquid-cap-usd": "0.50"
        }
      },
      "models": {
        "liquid.auto": { "name": "liquid.auto" }
      }
    }
  }
}
EOF2
  mv "$tmp" "$d/opencode.json"
)
```

The source builds the `models` object from the live book. The entry for `liquid.auto` above is a minimal form and its exact fields were not taken from the source. Check it against the OpenCode config docs.

Project config can override this global file. `OPENCODE_CONFIG_CONTENT` overrides the project config at run time.

## Run

```bash
opencode --model liquid/liquid.auto
opencode run --model liquid/liquid.auto 'Say ready.'
opencode models liquid
```

In a session, `/models` selects the provider and model.

## Verify

Send one request. Open Receipts on the Credits page. The client label is `OpenCode`, from the `X-Title` header. Read the charge from the receipt, not from the harness.

## Cap per request

`x-liquid-cap-usd` in `provider.liquid.options.headers` caps each request for all models. A header in a model's own `headers` overrides the provider header, so check both places. To limit total spend, set a spending limit on the key.

OpenCode 1.18.34 requests up to 32,000 output tokens when a custom model has no output limit. To use a smaller limit, set the model's `limit.output`.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The model is absent. | Add it to `provider.liquid.models` and run the script again. |
| `401` | Export `LIQUID_API_KEY` in the shell that starts OpenCode. Keep the env reference in the file. |
| `jq` reports a parse error. | The script needs valid JSON. It cannot edit comments (JSONC). |
| Wrong URL or cap is used. | Check project config, `OPENCODE_CONFIG`, `OPENCODE_CONFIG_CONTENT` and model headers. |
| `output_bound_unsupported` | Reduce `limit.output`, or select an offer that supports the requested limit. |
| No offer fits the cap. | Check the output limit and prices. Change the limit, cap or model. |

## Next

- [Pi](pi.md)
- [Harness index](README.md)
