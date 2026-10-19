# LangChain

Create the OpenAI chat model with the exchange as base URL. Source: derived from the Liquid Inference connection guide; an upstream canary covers the chat example. The authors of this repository did not re-run it.

```bash
pip install langchain-openai   # Python 3.10 or later
export LIQUID_API_KEY=sk-liquid-...
```

```python
import os
from langchain_openai import ChatOpenAI

llm = ChatOpenAI(
    base_url="https://router.inference.ai.exchange/v1",
    api_key=os.environ["LIQUID_API_KEY"],
    model="liquid.auto",
    default_headers={"X-Title": "LangChain"},
)

print(llm.invoke("Say hello.").content)
```

The `X-Title` header names the client on your receipts.

## Embeddings

```python
import os
from langchain_openai import OpenAIEmbeddings

embeddings = OpenAIEmbeddings(
    model="text-embedding-3-small",
    base_url="https://router.inference.ai.exchange/v1",
    api_key=os.environ["LIQUID_API_KEY"],
    check_embedding_ctx_length=False,
)

vectors = embeddings.embed_documents(["a cat on a bicycle", "a dog in a car"])
```

Set `check_embedding_ctx_length=False`. With `True`, the class sends arrays of token numbers, which the exchange refuses. With `False`, it sends the text. Pass `embeddings` to a vector store such as `QdrantVectorStore` or `PGVector`.

See the [shared notes](README.md#shared-notes) for caps, rules and errors.
