# Cursor

Cursor is a code editor with a built-in AI assistant. This guide covers the editor. It does not cover Cursor CLI. The editor uses the OpenAI Chat Completions format and lets you replace the OpenAI base URL.

Source: derived from the Liquid Inference connection guide for Cursor; config keys were not re-run by the authors of this repo.

## Prerequisites

- A workspace with a balance and a `spend` key.
- Cursor installed, with a project open.

Cursor has a settings screen and no config file or environment variable for this. You paste the key into the screen. Treat it as a secret and do not share a screenshot of it.

## Install

Install Cursor from its own site. Nothing else is needed.

## Configure

1. Open Settings, then Models.
2. Turn on **Override OpenAI Base URL** and enter:

```text
https://router.inference.ai.exchange/v1
```

The URL ends in `/v1`, because Cursor adds `/chat/completions`.

3. Paste your key into **OpenAI API Key**.
4. Add the model by name:

```text
liquid.auto
```

5. Use **Verify** to test the key with the first model.

Cursor lists only models it knows. Add each name by hand. You can add any model on the book. Get current names from `GET /v1/models`.

## Run

Pick the model in the Cursor model picker and chat as usual.

## Verify

Send one chat message. Open the receipt in the console and read the charge there. The source does not say which client label a Cursor receipt shows.

## Cap per request

Cursor cannot send the `x-liquid-cap-usd` header. `liquid.auto` has a cap of its own, so it works. To change the cap, use a preset that sets one. To limit total spend, set a spending limit on the key.

Some Cursor features, such as Tab completion and some agent modes, can go through Cursor servers. The override applies to chat and to the models you add.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Verifying the key fails. | The override is off, the URL lacks `/v1`, or the model name is not on the book. |
| The model is not in the picker. | Add it by name under Settings, Models. |
| A request is refused for lack of funds. | The balance cannot cover the cap. Add funds. |

## Next

- [Cline](cline.md)
- [Harness index](README.md)
