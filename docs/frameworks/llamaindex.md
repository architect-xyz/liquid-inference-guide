# LlamaIndex

Use the OpenAI-like embedding class with the exchange as base URL. Source: derived from the Liquid Inference connection guide. The authors of this repository did not re-run the example.

```bash
pip install llama-index-embeddings-openai-like   # Python 3.9 or later
export LIQUID_API_KEY=sk-liquid-...
```

Get an embedding model name from `GET /v1/models?kind=embedding`.

```python
import os
from llama_index.embeddings.openai_like import OpenAILikeEmbedding

embed_model = OpenAILikeEmbedding(
    model_name="text-embedding-3-small",
    api_base="https://router.inference.ai.exchange/v1",
    api_key=os.environ["LIQUID_API_KEY"],
    embed_batch_size=64,
)

vectors = embed_model.get_text_embedding_batch(["a cat on a bicycle", "a dog in a car"])
print(len(vectors), len(vectors[0]))

# To use it in every index and query engine:
from llama_index.core import Settings

Settings.embed_model = embed_model
```

Use `OpenAILikeEmbedding`, not `OpenAIEmbedding`: the latter accepts only OpenAI model names.

## Notes

- Keep one model per index. A model change needs a new index.
- A request holds up to 2,048 texts. Keep `embed_batch_size` at or below that.
- Embeddings have no streaming form.

See the [shared notes](README.md#shared-notes) for caps, rules and errors.
