---
name: liquid-embeddings
description: Embeds text into vectors through Liquid Inference's OpenAI-compatible embeddings endpoint and lists embedding models. Use when the user needs vector embeddings for search, RAG, clustering or a vector store on the exchange.
---

# Liquid Embeddings

`POST /v1/embeddings` has the OpenAI shape, so an unchanged OpenAI client works. Vectors come back in input order with an `index`. Only deployments registered to embed can win.

## Prerequisites

- `LIQUID_API_KEY` (a `spend` key) for embedding. Discovery needs none.
- Node 22 or later. No install step.

## Commands

```bash
node scripts/discover.mjs
node scripts/embed.mjs --model text-embedding-3-small "a cat on a bicycle" "a dog in a car" --output vectors.json
```

Discovery lists models with `kind: "embedding"`, their `max_input_tokens` and `min_input_rate`. Take a model name only from this list.

## Rules

- Up to 2,048 texts per request. Token arrays are refused; send strings.
- Keep one model per index. Changing model needs a new index and a re-embed.
- No streaming form.
- Cap with `--cap-usd`.

## In code

```python
from openai import OpenAI
import os

client = OpenAI(base_url="https://router.inference.ai.exchange/v1", api_key=os.environ["LIQUID_API_KEY"])
r = client.embeddings.create(model="text-embedding-3-small", input=["a cat on a bicycle"])
```

LangChain needs `check_embedding_ctx_length=False`; LlamaIndex needs `OpenAILikeEmbedding`. See the framework guides.

## Status

Discovery was run against the live exchange. `embed.mjs` was written from the docs and not run against a key.
