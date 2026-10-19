---
name: liquid-purchasing-rules
description: Set price caps, model baskets, ranking strategy and limits on Liquid Inference requests using the `exchange` block, x-liquid-* headers, model suffixes and presets. Use when the user wants to cap spend, pick cheapest/fastest/smartest, restrict providers, or tag costs.
---

# Liquid Inference purchasing rules

An optional `exchange` object in the request body sets how the exchange buys. `model` names what it buys; `exchange` has models (`exchange.models`), strategy (`exchange.strategy`) and limits (every other field). An unchanged SDK can send it as `extra_body`.

```python
client.chat.completions.create(
    model="liquid.auto",
    messages=[{"role": "user", "content": "Summarise this."}],
    extra_body={"exchange": {"cap_usd": 0.05, "ttft_ms": 1500, "excluded_providers": ["px_slow"]}},
)
```

An unknown field in `exchange` returns `400 invalid_request`.

## What `model` means

| `model` | Competes | `exchange.models` | `exchange.strategy` |
| --- | --- | --- | --- |
| A model, e.g. `gpt-oss-120b` | That model | Refused (`address_takes_no_basket`) | `price` or `fastest` |
| A router model, e.g. `liquid.auto` | Its candidates | Narrows them | `price`, `fastest`, `smartest`, or `auto` |
| `architect.basket` | The models in `exchange.models` (required) | Entries: model names, `provider/model` symbols, `*` patterns; `[]` means all listed | `price`, `fastest`, `smartest`, `auto` |
| A preset name | The preset's saved models | Replaces them | Replaces the saved strategy |

Suffixes rank by one word: `deepseek-v4.1-flash:fastest`, `liquid.auto:cheapest`, `:smartest`, `liquid.auto:balanced`.

## Headers (for clients that cannot change the body)

| Header | Equivalent |
| --- | --- |
| `x-liquid-cap-usd` | `cap_usd`: maximum charge for this request |
| `x-liquid-ttft-ms` | `ttft_ms` |
| `x-liquid-retention` | `retention_policy`: `none` or `allowed` |
| `x-liquid-rules` | A whole `exchange` block as JSON (cannot set models or strategy) |
| `x-liquid-tag` | A cost label kept on the job and receipt (1-63 chars, letters/digits/`.-_`) |
| `x-liquid-explain: true` | Adds a `routing` object to the response `exchange` block |
| `idempotency-key` | A repeat gets the first response; no second job |

Body, preset and single-rule headers win over `x-liquid-rules`. An unparseable header returns `400 invalid_header`. No header sets models or ranking; use a preset.

## Caps

The cap is per request, fixed before the first token. If the estimated charge exceeds it, the exchange refuses the request and never shrinks the output. An agent sends many requests, each with its own cap. For a total limit, give the process its own key with a spending limit (`budget_exhausted` when reached). `liquid.auto` has a default cap; the header replaces it.

## Presets

Saved models + strategy + limits under a name, managed in the console and used as `model`. Request values override preset values. A preset with strategy `auto` needs a price bound from the request, header, preset or key.

## Removed fields

`exchange.allowed_models` returns `400 invalid_request`. Use `model: "architect.basket"` with `exchange.models`.
