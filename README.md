# Liquid Inference guide

Guides and reference code for [Liquid Inference](https://router.inference.ai.exchange), an auction exchange for LLM inference. A buyer sends an ordinary OpenAI or Anthropic request. The exchange ranks the eligible offers, fixes a price cap before the first token, and charges for the tokens actually used.

Start with [getting started](docs/getting-started.md): get a key, set the base URL, send a request, read the receipt.

## Contents

| Section | For | Start here |
| --- | --- | --- |
| [Harnesses](docs/harnesses/README.md) | Run a coding agent (Claude Code, Codex, Cursor, Cline, OpenCode, Goose, Pi, OpenHands, Hermes Agent, Copilot CLI) on the exchange. | [index](docs/harnesses/README.md) |
| [Agent SDKs](docs/agent-sdks/README.md) | Build your own agent with the Claude Agent SDK, OpenAI Agents SDK or Vercel AI SDK. | [index](docs/agent-sdks/README.md) |
| [Frameworks](docs/frameworks/README.md) | Use LangChain, LlamaIndex or LiteLLM. | [index](docs/frameworks/README.md) |
| [Providers](docs/providers/README.md) | Sell inference. Reference agents in Python, TypeScript and Rust. | [overview](docs/providers/README.md) |

## Skills

[`skills/`](skills/README.md) holds fourteen agent skills (`SKILL.md` files) that teach a coding agent to use the exchange: quickstart, the Liquid CLI harness, purchasing rules, market data, receipts, troubleshooting, harness setup, agent SDKs, modalities (with scripts for images, speech, video and embeddings) and becoming a provider.

### Install the skills

With `npx skills` (needs Node):

```bash
# every skill, for your user, for every agent it detects
npx skills add architect-xyz/liquid-inference-guide --skill '*' --global --yes

# one skill, for one agent
npx skills add architect-xyz/liquid-inference-guide --skill liquid-quickstart --agent claude-code

# list the skills without installing
npx skills add architect-xyz/liquid-inference-guide --list
```

Leave out `--global` to install into the current project. Add `--copy` to copy files instead of symlinking them.

With the GitHub CLI (`gh skill` is in preview; checked with `gh` 2.102.0):

```bash
# every skill, into the current project
gh skill install architect-xyz/liquid-inference-guide --all

# every skill, for your user, for one agent
gh skill install architect-xyz/liquid-inference-guide --all --scope user --agent claude-code

# one skill
gh skill install architect-xyz/liquid-inference-guide liquid-quickstart
```

`--agent` takes a name such as `claude-code`, `codex`, `cursor`, `opencode` or `goose`; run `gh skill install --help` for the full list. Pin a version with `--pin <tag-or-sha>`.

Without `gh`, copy the directories by hand:

```bash
git clone https://github.com/architect-xyz/liquid-inference-guide
mkdir -p ~/.claude/skills
cp -R liquid-inference-guide/skills/* ~/.claude/skills/
```

Use the skills folder of your agent in place of `~/.claude/skills`. Copy the whole directory of a skill, because the modality skills carry a `scripts/` folder. Those scripts need Node 22 or later and no install step. Start a new agent session after you install.

An agent loads a skill when the task matches its description. To check, ask: "How do I send a first request to Liquid Inference?"

## Provider reference code

| Language | Code | Guide |
| --- | --- | --- |
| Python | [`providers/python`](providers/python) | [python.md](docs/providers/python.md) |
| TypeScript | [`providers/typescript`](providers/typescript) | [typescript.md](docs/providers/typescript.md) |
| Rust | [`providers/rust`](providers/rust) | [rust.md](docs/providers/rust.md) |

## Status of the content

These guides are derived from the Liquid Inference product docs and recipes. Each guide says what its source verified. The authors of this repository have not re-run the harness or SDK setups, and have not run the TypeScript or Rust provider references against a live router unless a README says so. Config keys and version pins change; check the harness's own docs when a step fails.

## Conventions

- The key is always read from `LIQUID_API_KEY`. Never put it in code or a committed file.
- Base URL for OpenAI-format clients: `https://router.inference.ai.exchange/v1`. For Anthropic-format clients: `https://router.inference.ai.exchange`.
- Examples cap each request at $0.50 with `x-liquid-cap-usd` or `exchange.cap_usd`.
- Read the charge from the receipt, not from a client's own cost display.
