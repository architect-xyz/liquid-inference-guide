---
name: liquid-quickstart
description: Point any OpenAI- or Anthropic-compatible client at Liquid Inference and send a first request. Use when the user wants to start using Liquid Inference, asks for the base URL, key setup or a minimal curl/SDK example.
---

# Liquid Inference quickstart

Liquid Inference is an auction exchange for LLM inference. An ordinary OpenAI or Anthropic request is ranked across providers' offers; the exchange fixes a price cap before the first token and charges for tokens actually used.

## Steps

1. The user needs a workspace with a balance and a key with the `spend` scope (format `sk-liquid-<key-id>-<secret>`, shown once). Never ask the user to paste the key into chat or code. Read it from the environment:
   ```bash
   export LIQUID_API_KEY=sk-liquid-...
   ```
2. Choose the base URL by client format:

   | Format | Base URL | Auth |
   | --- | --- | --- |
   | OpenAI | `https://router.inference.ai.exchange/v1` | `Authorization: Bearer $LIQUID_API_KEY` |
   | Anthropic | `https://router.inference.ai.exchange` (no `/v1`) | `x-api-key` or bearer |

   An Anthropic client adds `/v1/messages` itself, so a base URL ending in `/v1` produces `/v1/v1/messages`.
3. Pick a model. `liquid.auto` lets the exchange choose. `GET /v1/models` lists every valid name; the exchange refuses unknown names and never substitutes.
4. Send a request:
   ```bash
   curl https://router.inference.ai.exchange/v1/chat/completions \
     -H "Authorization: Bearer $LIQUID_API_KEY" \
     -H "Content-Type: application/json" \
     -d '{"model":"liquid.auto","messages":[{"role":"user","content":"Say hello."}]}'
   ```
5. The response has an `exchange` block (`job_id`, `provider_id`, `cap_usd`, `buyer_charge_usd`). Headers `x-liquid-job-id` and `x-liquid-cap-usd` arrive before the first token.

## Python and TypeScript

```python
import os
from openai import OpenAI

client = OpenAI(base_url="https://router.inference.ai.exchange/v1", api_key=os.environ["LIQUID_API_KEY"])
r = client.chat.completions.create(model="liquid.auto", messages=[{"role": "user", "content": "Say hello."}])
```

```typescript
import OpenAI from 'openai'

const client = new OpenAI({ baseURL: 'https://router.inference.ai.exchange/v1', apiKey: process.env.LIQUID_API_KEY })
```

## Endpoints

`POST /v1/chat/completions`, `POST /v1/responses` (no stored state), `POST /v1/messages`, `GET /v1/models`, `GET /v1/openapi.json`. The exchange does not search the web for a model; do that in your code.

## Related skills

`liquid-purchasing-rules` (caps and strategy), `liquid-receipts-costs`, `liquid-troubleshoot`.
