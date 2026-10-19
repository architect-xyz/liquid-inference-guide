---
name: liquid-models-market
description: Discover models, offers, prices and market depth on Liquid Inference through the public market endpoints. Use when the user asks what models are available, what they cost, who quotes a model, or how deep a market is.
---

# Liquid Inference models and market data

The public endpoints need no authentication and do not name providers.

| Method | Path | Returns |
| --- | --- | --- |
| `GET` | `/v1/models` | Models and router models with live quotes, plus the request parameters each supports. With a key, also your presets. |
| `GET` | `/v1/exchange/offers` | Each resting offer without the provider name, lowest generation rate first. |
| `GET` | `/v1/exchange/models` | One row per served model and kind: input/output modalities, price range, depth. |
| `GET` | `/v1/exchange/markets` | Depth per model: independent suppliers, offer count, liquidity. |
| `GET` | `/v1/exchange/routers` | Router models, ranking, default cap, rules, current candidates. |
| `GET` | `/v1/exchange/lifetime` | Jobs settled and tokens processed since opening. |

```bash
curl https://router.inference.ai.exchange/v1/exchange/offers
curl "https://router.inference.ai.exchange/v1/models?kind=embedding"
```

## Reading an offer

Key fields: `market`/`model`, `precision`, `region`, `input_length_band`, `output_limit_band`, `ttft_ms` and `completion_ms` (the deadlines the provider agrees to; a miss credits the buyer), `rate_uncached_input_usd_per_mtok`, `rate_generation_usd_per_mtok`, cache rates, `kind` (absent on chat), per-image/character/video-second rates, `synthetic`, `valid_until`.

Rates are USD per million tokens. A provider can change a rate at any time. A job pays the rate of the offer it won; the receipt records it.

## Tips

- `GET /v1/models` order: `liquid.auto`, other router models, your presets, tool-capable models, the rest. If a parameter is missing from a model's list, no resting offer supports it and the exchange refuses a request that includes it.
- To price a request before sending, estimate from `rate_*` and your token counts. The cap is the worst case, not the charge.
- The exchange's MCP server and CLI expose the same data; REST is the stable surface.
