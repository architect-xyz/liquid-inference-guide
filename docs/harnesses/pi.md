# Pi

Pi is a terminal coding agent. It uses the OpenAI Chat Completions format and has no setting for a custom base URL. Providers and their models must be in `~/.pi/agent/models.json`.

Source: derived from the Liquid Inference connection guide for Pi; config keys were not re-run by the authors of this repo.

## Prerequisites

- A workspace with a balance and a `spend` key.
- Node.js 22.19 or newer, and `jq`.
- The key exported in your shell:

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## Install

```bash
# installer
curl -fsSL https://pi.dev/install.sh | sh

# or with npm
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

## Configure

Pi does not read `/v1/models`, and it asks for 16,384 output tokens if a model sets no `maxTokens`. This block reads the live book, keeps your other providers, and writes `contextWindow`, `maxTokens`, `reasoning` and `input` for each model.

The `apiKey` field is the literal text `$LIQUID_API_KEY`. Pi expands it at run time, so the file holds no key.

```bash
mkdir -p ~/.pi/agent && touch ~/.pi/agent/models.json
curl -fsSL https://router.inference.ai.exchange/v1/models -H "Authorization: Bearer $LIQUID_API_KEY" | jq --slurpfile cur ~/.pi/agent/models.json '
  .data as $book | ($cur[0] // {}) | .providers.liquid = {
    baseUrl: "https://router.inference.ai.exchange/v1",
    api: "openai-completions",
    apiKey: "$LIQUID_API_KEY",
    headers: { "x-liquid-cap-usd": "0.50" },
    models: [$book[] | (.liquid_supported_parameters // []) as $p | {
      id,
      contextWindow: (.max_input_tokens // 128000),
      maxTokens: (.max_tokens // 8192),
      reasoning: ($p | index("reasoning.effort") != null),
      input: (if ($p | index("input.image")) then ["text", "image"] else ["text"] end)
    }]
  }' > ~/.pi/agent/models.json.new && mv ~/.pi/agent/models.json.new ~/.pi/agent/models.json
```

Run the block again when the book changes. It replaces only the `liquid` provider and resets its headers.

## Run

```bash
pi --model liquid/liquid.auto
```

`/model` changes the model in a session. To set effort for one launch, add it to the id, for example `liquid/liquid.auto:high`. To make a model the default, set `defaultProvider` and `defaultModel` in `~/.pi/agent/settings.json`.

## Verify

Send one request. Open the receipt in the console. Read the charge from the receipt, not from the harness display. The source does not state a client label for Pi.

## Cap per request

The provider sends `x-liquid-cap-usd` on each request. Edit it in `providers.liquid.headers` in `models.json`. The cap applies to one request. To limit total spend, set a spending limit on the key.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| The model is not listed. | The book changed. Run the block again. |
| `401` | `apiKey` must stay `$LIQUID_API_KEY`, with the `$`. Without it, Pi sends the literal name. |
| `output_bound_unsupported` | `maxTokens` is above what the offer allows. Run the block again. |
| `jq` reports a parse error. | `models.json` has comments. Edit the `liquid` provider by hand, or remove the comments. |

## Next

- [OpenCode](opencode.md)
- [Harness index](README.md)
