---
name: install-liquid-harness
description: Install the Liquid CLI (`liquid`), sign in, and run an existing coding agent (Claude Code, Codex, OpenCode, Goose and others) through Liquid Inference with model selection, a per-request cap, upgrades and verification. Use when the user wants to run a coding agent on the exchange without editing its config files.
---

# Install and run Liquid Harness

The Liquid CLI starts the coding agent that is already on `PATH` with the exchange as its provider. It sets the base URL, key and model in that process's environment only. It writes no config file of the agent, and the key is never in one.

## When to use

Use it to install `liquid`, sign in, run an agent through the exchange, pick a model or cap, update the CLI, or check the setup. For a harness the CLI does not start, or for manual config, use `liquid-connect-harness`. For SDK code, use `liquid-agent-sdk`.

## Prerequisites

- macOS or Linux, Intel or Arm.
- A coding agent CLI on `PATH`. If it is missing, `liquid <tool>` prints how to install it.
- A Liquid Inference account with a balance. Sign-in uses a browser.

## Install

Running a remote install script changes the user's machine. Tell the user what you will run and get a go-ahead first. Do not use `sudo`.

```bash
curl -fsSL https://inference.ai.exchange/cli/install.sh | bash
liquid --version
```

The installer checks the checksum and puts `liquid` in `~/.local/bin`. If `liquid` is not found, add that directory to `PATH` and open a new shell. `LIQUID_INSTALL_DIR` changes the directory and `LIQUID_CLI_VERSION` pins a version.

## Sign in

```bash
liquid login
```

The command opens a browser. After approval it saves a token for the CLI and creates an API key named after the computer for the coding agents. The key is not shown, and it can spend the workspace balance. Settings go to `~/.config/liquid/config.toml` with mode `0600`.

- No browser available: a workspace owner or admin approves in another place. A member can save a key someone else made with `liquid login --key sk-liquid-...`. Ask the user to run that themselves so the key does not pass through chat.
- `LIQUID_API_KEY` and `LIQUID_BASE_URL` in the environment override the file.
- `liquid logout` removes the saved key and token.

## Run an agent

```bash
liquid tools            # list every agent the CLI can start
liquid claude
liquid codex
liquid opencode
liquid goose
```

Arguments the CLI does not use go to the agent unchanged:

```bash
liquid claude -p "explain this repository"
liquid codex --cap 0.50 exec "say ready"
```

## Model and cap

```bash
liquid model                      # list and pick a default
liquid model liquid/auto          # save a default
liquid model liquid/auto:fastest  # rank by speed
liquid model --list               # table, no prompt
liquid cap 0.50                   # most one request may cost
liquid claude --model liquid/auto --cap 0.25   # for one run
```

Suffixes: `:premium`, `:balanced`, `:economy`, `:smartest`, `:fastest`, `:cheapest`. A flag on one run beats a saved setting. For Claude Code, the first argument can set `main/sub` models, for example `liquid claude opus/auto`; with no model set the default is `opus/auto`.

Other settings that apply to every tool: `liquid config rank economy`, `liquid config effort high` (Codex only), `liquid config ttft 2000`, `liquid config rules '{"region_policy":["eu"]}'`, `liquid config context 1m` (Claude Code).

## Other programs

```bash
liquid connect cursor            # print the setup for an app or SDK
liquid exec -- python app.py     # run any program with the exchange in its environment
```

## Update

```bash
liquid update
liquid --version
```

Do not use `liquid update` in a source checkout as a replacement for installing the released CLI.

## Verify

```bash
liquid codex --cap 0.10 exec "Reply with exactly: Liquid is connected"
liquid job
```

The agent should start and answer. `liquid job` lists settled jobs; the newest should be this run. When the agent exits at a terminal, `liquid` also prints the request count, the cost, and the largest charge against the cap. Use `liquid claude -p "..."` instead if Claude Code is the chosen agent.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `liquid` not found | Add `~/.local/bin` (or `LIQUID_INSTALL_DIR`) to `PATH`; open a new shell. |
| Agent missing | Run the install command `liquid <tool>` prints, then rerun. |
| Browser does not open | Open the URL the login command prints. |
| Authentication fails or a model is rejected | Report the exact output. Check `liquid model --list` for the name. |
| Requests refused for funds | Add funds to the workspace; check `liquid workspace balance`. |
| Update notice on every command | `LIQUID_NO_UPDATE_CHECK=1` turns the daily check off. |

The CLI sends one anonymous usage event per command (command name, tool id, version, OS, success). It never sends prompts, paths, model names or keys. `liquid telemetry off`, `LIQUID_TELEMETRY=off` or `DO_NOT_TRACK=1` disables it.

## Status

Written from the Liquid CLI documentation. Not run by the authors of this repository. The CLI documentation uses model ids such as `liquid/auto`, while API examples elsewhere use `liquid.auto`; use `liquid model --list` for the names your version accepts.
