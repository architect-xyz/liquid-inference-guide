# Framework integrations

Frameworks that wrap an OpenAI-compatible client. Each one needs the exchange base URL ending in `/v1` and your key from `LIQUID_API_KEY`.

| Framework | Language | Use for | Guide |
| --- | --- | --- | --- |
| LangChain | Python | Chat models, embeddings | [langchain.md](langchain.md) |
| LlamaIndex | Python | Embeddings for indexes | [llamaindex.md](llamaindex.md) |
| LiteLLM | Python | One interface to many APIs | [litellm.md](litellm.md) |

For agent loops, see [Agent SDKs](../agent-sdks/README.md).

## Shared notes

- The exchange sets a cap on each request. It is in the `x-liquid-cap-usd` response header. For a total limit, set a spending limit on the key.
- Send purchasing rules as an `exchange` block in `extra_body`. See [getting started](../getting-started.md#purchasing-rules).
- Get current model names from `GET /v1/models`.

| Symptom | Fix |
| --- | --- |
| `401` | Key wrong, revoked or expired. Export it again. |
| `404` | Keep `/v1` at the end of the base URL. |
| `model_not_found` | Use an exact name from `GET /v1/models`. |
| Refused for lack of funds | The balance cannot cover the cap. Add funds. |
