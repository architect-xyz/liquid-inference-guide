# OpenHands

OpenHands runs an agent with local file and shell tools. Use the Python SDK in your application, or the CLI for a terminal session. Both send OpenAI-format requests.

Source: derived from the Liquid Inference connection guide for OpenHands; config keys were not re-run by the authors of this repo. The source marks the SDK code block as a canary example. The source does not state a result.

## Prerequisites

- A workspace with a balance and a `spend` key.
- Python 3.12 or later.
- `tmux` for the terminal tool (`brew install tmux`, or `sudo apt-get install tmux`).
- A model whose offer supports text, tool calls and an output limit of at least 8,192 tokens.

```bash
export LIQUID_API_KEY=sk-liquid-...
```

## SDK

Install:

```bash
pip install openhands-sdk openhands-tools
```

Save as `agent.py`:

```python
import os
from pathlib import Path

from openhands.sdk import Agent, Conversation, LLM, Tool
from openhands.tools.file_editor import FileEditorTool
from openhands.tools.terminal import TerminalTool


def create_agent() -> Agent:
    return Agent(
        llm=LLM(
            model="openai/liquid.auto",
            base_url="https://router.inference.ai.exchange/v1",
            api_key=os.environ["LIQUID_API_KEY"],
            extra_headers={"X-Title": "OpenHands SDK", "x-liquid-cap-usd": "0.50"},
            max_output_tokens=8192,
            native_tool_calling=True,
            reasoning_effort=None,
        ),
        tools=[Tool(name=TerminalTool.name), Tool(name=FileEditorTool.name)],
    )


def main() -> None:
    conversation = Conversation(agent=create_agent(), workspace=str(Path.cwd()))
    try:
        conversation.send_message("List the files here.")
        conversation.run()
    finally:
        conversation.close()


if __name__ == "__main__":
    main()
```

Run it with `python agent.py`. The model name has the `openai/` prefix, which LiteLLM uses to pick the OpenAI format. The tools run in the current directory, so use a project directory where the agent may change files.

## CLI

Use a separate Python environment from the SDK.

```bash
python3.12 -m venv .venv-openhands
source .venv-openhands/bin/activate
pip install openhands
```

Set the model environment in the same shell:

```bash
export LLM_API_KEY="$LIQUID_API_KEY"
export LLM_BASE_URL="https://router.inference.ai.exchange/v1"
export LLM_MODEL="openai/liquid.auto"
```

Apply the exchange settings to `~/.openhands/agent_settings.json`. The script keeps unrelated settings and writes a dummy key to the file. The environment supplies the real key.

```bash
python3 - <<'PY'
import json
from pathlib import Path

path = Path.home() / ".openhands" / "agent_settings.json"
settings = json.loads(path.read_text()) if path.exists() else {}
llm = settings.setdefault("llm", {})
for config in [llm, (settings.get("condenser") or {}).get("llm")]:
    if config is None:
        continue
    config.update({
        "model": "openai/liquid.auto",
        "base_url": "https://router.inference.ai.exchange/v1",
        "api_key": "env-overrides-key",
        "max_output_tokens": 8192,
        "native_tool_calling": True,
        "reasoning_effort": None,
    })
    headers = config.get("extra_headers") or {}
    headers.update({
        "X-Title": "OpenHands CLI",
        "x-liquid-cap-usd": "0.50",
    })
    config["extra_headers"] = headers
    body = config.get("litellm_extra_body") or {}
    exchange = body.get("exchange") or {}
    exchange.pop("cap_usd", None)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps(settings, indent=2) + "\n")
PY
```

Pass `--override-with-envs` on every CLI command. Without it, the CLI uses the dummy key from the file. The flag replaces the file's model, key and base URL with the environment values. The source does not show the full run command, so check `openhands --help`.

## Verify

Open Receipts on the Credits page. The client label is `OpenHands SDK` or `OpenHands CLI`. Read the charge from the receipt. The harness token usage does not state the exchange charge.

## Cap per request

The `x-liquid-cap-usd` header caps each model request. A session sends many requests, so use a separate key with a spending limit to cap the total. Keep the cap in the header. Do not add a second cap in the request body.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `401` | Check the key. For the CLI, add `--override-with-envs`. |
| `model_not_found` | Pick a name from `GET /v1/models` and keep the `openai/` prefix. |
| The request exceeds the cap | Lower the output limit, or raise the cap in `extra_headers`. |
| Insufficient funds | Add funds on the Credits page. |

## Next

- [Hermes Agent](hermes-agent.md)
- [Harness index](README.md)
