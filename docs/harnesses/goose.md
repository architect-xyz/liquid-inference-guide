# Goose

Goose is an agent for the terminal and desktop. This guide uses its custom OpenAI-compatible provider. One provider file holds the URL, model data and headers.

Source: derived from the Liquid Inference connection guide for Goose; config keys were not re-run by the authors of this repo. The source states the setup is tested with Goose 1.53.0.

## Prerequisites

- A workspace with a balance and a `spend` key. Each team member should use their own key.
- macOS or Linux for the CLI commands.
- Goose 1.53.0.

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install

```bash
curl -fsSL https://github.com/aaif-goose/goose/releases/download/v1.53.0/download_cli.sh | GOOSE_VERSION=1.53.0 CONFIGURE=false bash
export PATH="$HOME/.local/bin:$PATH"
```

## Configure

Write `~/.config/goose/custom_providers/custom_liquid.json`. Create the directory first. If you set `XDG_CONFIG_HOME`, use its `goose/custom_providers` directory. If you set `GOOSE_PATH_ROOT` (an absolute path), use its `config/custom_providers` directory.

```json
{
  "name": "custom_liquid",
  "engine": "openai",
  "display_name": "Liquid Inference",
  "api_key_env": "LIQUID_API_KEY",
  "base_url": "https://router.inference.ai.exchange/v1/chat/completions",
  "models": [
    {
      "name": "liquid.auto",
      "context_limit": 128000
    }
  ],
  "headers": {
    "X-Title": "Goose",
    "x-liquid-cap-usd": "0.50"
  },
  "supports_streaming": true,
  "requires_auth": true,
  "dynamic_models": true
}
```

- Keep `api_key_env` as `LIQUID_API_KEY`, without `$`. Do not put the key in a header.
- `base_url` is the full Chat Completions URL.
- `context_limit` is 128,000 here when no live limit is available. Change it to match your model.
- `dynamic_models` makes the picker read `GET /v1/models`.

## Run

The source uses the `--model`, `--no-profile` and `--with-builtin developer` options, and a `goose configure` flow to set the default provider. The exact command lines were not in the source recipe, so check `goose --help`.

```bash
goose configure
```

Select Configure Providers, then Liquid Inference, then a model.

Goose Desktop uses the same provider directory. It does not inherit a terminal environment. Open Settings, Models, Configure providers, select Liquid Inference, and enter the key in the API Key field. Goose stores it in its keychain, or in `secrets.yaml` if the keychain is unavailable. Keep that file private.

## Verify

Send a short request that asks for the word `ready`. Open Credits, then Receipts. The client label is `Goose`. Read the charge from the receipt, not from the harness.

## Cap per request

`x-liquid-cap-usd` in the provider file caps each request. A task can send several requests, so the cap does not limit the total. Set a spending limit on the key.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| `goose` is not on `PATH`. | Add `~/.local/bin` to `PATH`. |
| The provider is absent. | Check the provider directory and that the file is valid JSON. Restart Goose. |
| Goose cannot get `LIQUID_API_KEY`. | Export it in the CLI shell. In Desktop, enter it in the provider controls. |
| `401` | The key is invalid or expired. |
| `403` | Check the key's `spend` scope, address restriction and preset rules. |
| `402` | Add credit, or check the key's spend limit. |
| `404` | Keep the full `/v1/chat/completions` URL in `base_url`. |
| The model is absent. | Check live offers and presets. Select an exact name with `--model`. |
| `output_bound_unsupported` | Select a model with an offer that accepts the output limit. |
| `cap_exceeds_buyer_cap` | Raise the request cap or pick a cheaper model. |

## Next

- [Pi](pi.md)
- [Harness index](README.md)
