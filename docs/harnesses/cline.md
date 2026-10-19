# Cline

Cline has a CLI and a VS Code extension. Both have an "OpenAI Compatible" provider that uses Chat Completions.

Source: derived from the Liquid Inference connection guide for Cline; config keys were not re-run by the authors of this repo. The source marks the CLI path as "CLI verified". That label does not apply to the VS Code extension. The source does not describe the verification.

## Prerequisites

- A workspace with a balance and a `spend` key.
- For the CLI: Node 22 or newer, and `jq`.
- For the extension: Cline from the VS Code marketplace.

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install (CLI)

```bash
npm install -g cline
npm rebuild -g cline
```

## Configure the extension

1. Open the Cline settings panel. Set the API provider to **OpenAI Compatible**.
2. Set **Base URL** to `https://router.inference.ai.exchange/v1`. It ends in `/v1`, because Cline adds `/chat/completions`.
3. Paste your key into **API Key**.
4. Set **Model ID** to `liquid.auto`. Cline reads `GET /v1/models` and lists names.
5. Add custom headers:
   - `X-Title`: `Cline`
   - `x-liquid-cap-usd`: `0.50`

## Configure the CLI

This script uses `cline auth`, then merges the provider settings. It keeps other providers, preferences and custom headers.

```bash
set -e
umask 077
cline_settings="$HOME/.cline/data/settings/providers.json"
cline_saved=$(mktemp)
trap 'rm -f "$cline_saved" "$cline_settings.new"' EXIT
if [ -f "$cline_settings" ]; then
  jq '.' "$cline_settings" > "$cline_saved"
else
  printf '{}' > "$cline_saved"
fi
cline auth --provider openai-compatible --apikey "$LIQUID_API_KEY" --modelid 'liquid.auto' --baseurl 'https://router.inference.ai.exchange/v1'
jq --slurpfile saved "$cline_saved" '$saved[0] * . | .providers["openai-compatible"].settings |= (.maxTokens = 8192 | .headers = ((.headers // {}) | with_entries(select((.key | ascii_downcase) != "x-title" and (.key | ascii_downcase) != "x-liquid-cap-usd")) + {"X-Title": "Cline", "x-liquid-cap-usd": "0.50"}))' "$cline_settings" > "$cline_settings.new" && mv "$cline_settings.new" "$cline_settings"
```

`cline auth` takes the key as a command argument and stores it in the settings file. The source guide does the same.

The script stores `maxTokens: 8192`. The source says release 3.0.69 does not send this limit. Then the exchange applies its default output limit.

## Run

```bash
cline
```

For the extension, open Cline in VS Code.

## Verify

Send one task. Open Receipts on the Credits page. The client label is `Cline`, from the `X-Title` header. Read the charge from the receipt, not from the harness cost display.

## Cap per request

The `x-liquid-cap-usd` header above caps each request. To limit total spend, set a spending limit on the key.

Cline writes full files. Use a model with a large output limit. If the offers allow less than Cline asks for, the exchange lowers the request and a long answer stops there.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `401` or an authentication error | The key is empty or wrong, or the provider is not "OpenAI Compatible". |
| `model_not_found` | The model ID is not on the book. Check `GET /v1/models`. |
| The model list is empty | The base URL is wrong. It must end in `/v1`. |
| Your presets are not listed | The key is empty or is from a different workspace. |
| Answers stop at the output limit | The offers allow less output than Cline asked for. Choose a model that allows more. |
| A request is refused for lack of funds | The balance cannot cover the cap. Add funds. |
| `jq` reports a parse error | The existing settings file is not valid JSON. Fix it and run the script again. |

## Next

- [Cursor](cursor.md)
- [Harness index](README.md)
