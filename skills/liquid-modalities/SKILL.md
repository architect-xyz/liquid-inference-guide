---
name: liquid-modalities
description: Send images, audio, PDFs, embeddings and speech/image/video generation jobs through Liquid Inference. Use when the user needs attachments, vector embeddings, text-to-speech, image generation or video generation on the exchange.
---

# Modalities on Liquid Inference

This is the overview. For scripts that discover models and run a job, use `liquid-images`, `liquid-speech`, `liquid-video` or `liquid-embeddings`.

`GET /v1/exchange/models` shows each model's `input_modalities` and `output_modalities`; empty means text only. A request competes only across offers that declared the feature.

## Attachments in chat

| Kind | Chat Completions part | Messages block |
| --- | --- | --- |
| Image | `image_url` (`detail`: auto, low, high) | `image` |
| Audio | `input_audio` (`data` base64, `format`) | none |
| PDF | `file` (`file_data` as `data:application/pdf;base64,...`) | `document` |
| Video input | `video_url` | none, and no provider reads it: refused `unsupported_content` |

- Only an image may be an `https://` URL; it is priced at a fixed 1,200 tokens and fewer offers can serve it. Send bytes inline so the cap is set from the real image.
- All other parts must be inline base64. Remote documents or audio get `400 unsupported_content`.
- Readable types: png, jpeg, webp, gif; wav, flac, mp3; pdf only.
- Body limit 20 MB by default (about 15 MiB of attachments after base64).
- The cap includes attachment tokens, estimated from headers; default table: image 85 + 170 per 512 px tile, audio 50 per second, PDF 3,000 per page. The charge is the provider's metered count.

## Embeddings

`POST /v1/embeddings`, OpenAI shape, `input` a string or list (up to 2,048 texts). List embedding models with `GET /v1/models?kind=embedding`. Keep one model per index. Token arrays are refused.

## Images

`POST /v1/images/generations` with `model`, `prompt`, `n` (1-10), optional `size` (see the model card's `image_sizes`) and `response_format`. Priced per image, so the cap equals the charge. No streaming.

## Speech

`POST /v1/audio/speech` with `model`, `input` (max 4,096 characters), `voice`, `response_format`, optional `speed` (0.25-4.0). Priced per character. The body is the audio; the `exchange` block is JSON in the `x-liquid-exchange` header.

## Video

Asynchronous. `POST /v1/videos` with `model`, `prompt`, `seconds` (1-20), `size`. Poll `GET /v1/videos/{id}` until `completed` or `failed`, then `GET /v1/videos/{id}/content`. Priced per second. `input_reference` is refused.

A router model that ranks by price cannot buy image or speech jobs (`unsupported_model`); name the model. Token-based price rules on these jobs give `unsupported_rule`.
