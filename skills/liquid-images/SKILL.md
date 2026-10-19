---
name: liquid-images
description: Generates images from text prompts through Liquid Inference's OpenAI-compatible images endpoint and discovers which image models and sizes are available. Use when the user asks to create or generate an image on the exchange.
---

# Liquid Images

Generates images with `POST /v1/images/generations`. Priced per image, so the cap equals the charge. There is no streaming form. Image editing is not documented for the exchange, so this skill does not do it.

## Prerequisites

- `LIQUID_API_KEY`: a `spend` key, for generation. Discovery needs no key.
- Node 22 or later. The scripts have no dependencies; no install step.

## Decision tree

| User intent | Command |
| --- | --- |
| List image models and their sizes | `node scripts/discover.mjs` |
| Inspect one model | `node scripts/discover.mjs <model>` |
| Generate | `node scripts/generate.mjs "prompt" --model <id>` |

## Discover first

`discover.mjs` reads the public `GET /v1/models` list and keeps entries with `kind: "image_generation"`. `image_sizes` lists the values valid for `--size`. If a model has no `image_sizes`, omit `--size`; the provider uses its default, and the request can go to more offers.

## Generate

```bash
node scripts/generate.mjs "a red paper boat on a stream" --model alibaba/wan2.6-image --size 1024x1024 --n 2 --output boat.png --cap-usd 0.10
```

| Flag | Purpose |
| --- | --- |
| `--model` | Required. Image model id from discovery. |
| `--n` | 1 to 10 images. |
| `--size` | One of the model's `image_sizes`. |
| `--response-format` | `b64_json` or `url`. If set, only offers that list that form compete. |
| `--output` | File path. Several images get `-1`, `-2` suffixes. |
| `--cap-usd` | Sends `x-liquid-cap-usd`. |

The script prints JSON: `model`, `prompt`, `images_saved`, `count` and the response `exchange` block (job id, provider, cap, charge). The exchange does not host images; a `url` result points at the provider's storage, so the script downloads it at once.

A size or format no offer declares is routed to another offer, not failed after the choice. A router model that ranks by price cannot buy images (`unsupported_model`); name the model. Token-based price rules give `unsupported_rule`.

## Presenting results

Show the saved files, state the model and the charge from `exchange.buyer_charge_usd` if present, and report where the files were saved.

## Status

Discovery was run against the live exchange. Generation was written from the docs and not run, because it spends money.
