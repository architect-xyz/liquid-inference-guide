# LiteLLM

Use LiteLLM's OpenAI-compatible route. Source: derived from the Liquid Inference connection guide; the upstream recipe is marked as not canaried. The authors of this repository did not re-run it.

```bash
pip install litellm   # Python 3.10 or later
export LIQUID_API_KEY=sk-liquid-...
```

```python
import os
import litellm

response = litellm.completion(
    model="openai/liquid.auto",
    api_base="https://router.inference.ai.exchange/v1",
    api_key=os.environ["LIQUID_API_KEY"],
    extra_headers={"X-Title": "LiteLLM"},
    messages=[{"role": "user", "content": "hello"}],
)
print(response.choices[0].message.content)
```

The `openai/` prefix selects the API format. The exchange auctions the model that follows it. `X-Title` names the client on your receipts.

See the [shared notes](README.md#shared-notes) for caps, rules and errors.
