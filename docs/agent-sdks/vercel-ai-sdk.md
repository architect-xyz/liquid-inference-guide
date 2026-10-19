# Vercel AI SDK

The Vercel AI SDK (`ai`) calls models from TypeScript. Use the `@ai-sdk/openai-compatible` provider with the exchange as base URL.

Source: derived from the Liquid Inference connection guide. A TypeScript canary exists upstream with `ai` 7.0.133 and `@ai-sdk/openai-compatible` 3.0.66. The authors of this repository did not re-run it.

## Install and configure

```bash
# Node 22 or later
npm install ai @ai-sdk/openai-compatible
export LIQUID_API_KEY=sk-liquid-...
```

```typescript
import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { generateText } from 'ai'

const liquid = createOpenAICompatible({
  name: 'liquid',
  baseURL: 'https://router.inference.ai.exchange/v1',
  apiKey: process.env.LIQUID_API_KEY,
  headers: { 'x-liquid-cap-usd': '1.00' },
})

const { text } = await generateText({
  model: liquid('liquid.auto'),
  prompt: 'Say hello.',
})
console.log(text)
```

The `x-liquid-cap-usd` header caps each request at $1.00. `generateText` sends an `ai/` user agent token, which the exchange uses to label the client **Vercel AI SDK** on receipts.

## Notes

- Choose a model from `GET /v1/models`. The base URL ends in `/v1`.
- Purchasing rules other than the cap go in `providerOptions`; see [getting started](../getting-started.md#purchasing-rules).
- Local tools defined with `tool()` run in your process.
- To limit total spend, give the app its own key with a spending limit.

| Symptom | Fix |
| --- | --- |
| `401` | Key wrong, revoked, or missing the `spend` scope. |
| `404` | Keep `/v1` at the end of `baseURL`. |
| `model_not_found` | Use an exact name from `GET /v1/models`. |
| Refused for lack of funds | Add funds to the workspace. |
