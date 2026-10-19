---
name: liquid-speech
description: Synthesizes speech from text through Liquid Inference's OpenAI-compatible audio endpoint and lists speech models. Use when the user asks to turn text into audio, narrate, or do text-to-speech on the exchange.
---

# Liquid Speech

Generates audio with `POST /v1/audio/speech`. Priced per character of input (characters, not bytes), so the cap equals the charge. Maximum 4,096 characters. No streaming: the clip arrives complete.

## Prerequisites

- `LIQUID_API_KEY` (a `spend` key) for synthesis. Discovery needs none.
- Node 22 or later. No install step.

## Commands

```bash
node scripts/discover.mjs                      # list audio_speech models
node scripts/speak.mjs "Hello there." --model tts-1 --voice alloy --format mp3 --output hello.mp3 --cap-usd 0.05
```

| Flag | Purpose |
| --- | --- |
| `--model` | Required. A speech model from discovery, for example `tts-1`. |
| `--voice` | Required. A voice the deployment speaks. |
| `--format` | `response_format`, default `mp3`. |
| `--speed` | 0.25 to 4.0. Changes length, not cost. |
| `--output` | File path, default `speech.<format>`. |
| `--cap-usd` | Sends `x-liquid-cap-usd`. |

The model card does not list voices. The exchange compares `voice` and `response_format` with what each offer declares, and a request no offer matches fails with a routing error. If a voice is refused, try another name, such as one the model's upstream documents.

The response body is the audio, so the script reads the job id, cap and the `exchange` JSON from the `x-liquid-job-id`, `x-liquid-cap-usd` and `x-liquid-exchange` headers. `exchange` reports `characters`, so compare it with what you sent.

A router model that ranks by price cannot buy speech (`unsupported_model`); name the model.

## Status

Discovery was run against the live exchange. Synthesis was written from the docs and not run, because it spends money.
