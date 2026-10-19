# Getting started

Liquid Inference is an auction exchange for inference. You send an ordinary OpenAI or Anthropic request. The exchange ranks the offers that quote your model, fixes a price cap before the first token, and charges for the tokens actually used.

Every guide in this repository assumes the setup below.

## 1. Get a key

Sign up to create a workspace (it holds a balance, keys and receipts). Issue a key on the **API keys** page. It is shown once and looks like `sk-liquid-<key-id>-<secret>`.

| Scope | Can |
| --- | --- |
| `spend` | Place jobs. Use this for agents and harnesses. |
| `read` | Read receipts and the balance. |
| `list` | Read the book. |

A key can have a spending limit. Give each agent its own key to bound its total spend.

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## 2. Point a client at the exchange

| Format | Base URL | Auth header |
| --- | --- | --- |
| OpenAI | `https://router.inference.ai.exchange/v1` | `Authorization: Bearer sk-liquid-...` |
| Anthropic | `https://router.inference.ai.exchange` | `x-api-key: sk-liquid-...` |

An OpenAI client adds `/chat/completions` or `/responses`. An Anthropic client adds `/v1/messages`, so an Anthropic base URL ending in `/v1` sends requests to `/v1/v1/messages`.

## Send a request

```bash
curl https://router.inference.ai.exchange/v1/chat/completions \
  -H "Authorization: Bearer $LIQUID_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model": "liquid.auto", "messages": [{"role": "user", "content": "Say hello."}]}'
```

The response gains an `exchange` block: `job_id`, `provider_id`, `cap_usd` (the maximum cost) and `buyer_charge_usd` (the real cost). Two headers arrive before the first token: `x-liquid-job-id` and `x-liquid-cap-usd`.

Read the receipt with a `read` key or better:

```bash
curl https://router.inference.ai.exchange/v1/exchange/jobs/<job_id> \
  -H "Authorization: Bearer $LIQUID_API_KEY"
```

A receipt can return `404` for a moment after the answer. Retry.

## Choose a model

| `model` value | Meaning |
| --- | --- |
| `gpt-oss-120b` | Each provider that quotes that model competes. |
| `liquid.auto` | The exchange chooses among listed models. Add `:cheapest`, `:fastest`, `:smartest` or `:balanced`. |
| `architect.basket` | The models in `exchange.models` compete. |
| A preset name | Saved models, strategy and limits. |

`GET /v1/models` lists every name you can use now. The exchange refuses other names; it never substitutes a model.

## Purchasing rules

An optional `exchange` object in the body sets limits and strategy. An unchanged SDK can send it as `extra_body`:

```python
response = client.chat.completions.create(
    model="liquid.auto",
    messages=[{"role": "user", "content": "Summarise this."}],
    extra_body={"exchange": {"cap_usd": 0.05, "ttft_ms": 1500}},
)
```

A client that cannot change the body sends headers instead, such as `x-liquid-cap-usd`. A header that cannot be parsed returns `400 invalid_header`. No header sets models or ranking; use a preset for that.

## Endpoints

| Method | Path | Description |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions. |
| `POST` | `/v1/responses` | OpenAI Responses, without stored state. |
| `POST` | `/v1/messages` | Anthropic Messages. |
| `GET` | `/v1/models` | Models with live quotes. |
| `GET` | `/v1/openapi.json` | OpenAPI 3.1 document of the public API. |

The exchange does not search the web for a model. Do the search in your code or a function tool.

## Where next

- [Harnesses](harnesses/README.md): coding agents such as Claude Code and Codex.
- [Agent SDKs](agent-sdks/README.md): libraries for your own agent.
- [Frameworks](frameworks/README.md): LangChain, LlamaIndex, LiteLLM.
- [Providers](providers/README.md): sell inference, with reference code in Python, TypeScript and Rust.
