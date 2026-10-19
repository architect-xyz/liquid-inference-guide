---
name: liquid-video
description: Generates video from a text prompt through Liquid Inference's asynchronous videos endpoint (create, poll, download) and lists video models. Use when the user asks to make or render a video on the exchange.
---

# Liquid Video

`POST /v1/videos` accepts a job when a provider takes it, `GET /v1/videos/{id}` reports status, and `GET /v1/videos/{id}/content` returns the file. Priced per second requested, so the cap is known before the job starts. A render takes under a minute to several minutes.

## Prerequisites

- `LIQUID_API_KEY` (a `spend` key). Discovery needs none.
- Node 22 or later. No install step.

## Commands

```bash
node scripts/discover.mjs
node scripts/generate.mjs "a red paper boat on a stream" --model seedance-1.0 --seconds 5 --size 1280x720 --output boat.mp4 --cap-usd 1.00
```

| Flag | Purpose |
| --- | --- |
| `--model` | Required. A `video_generation` model from discovery. Names change; do not assume `seedance-1.0` exists. |
| `--seconds` | 1 to 20. If omitted, the exchange uses the shortest length an offer declares, else 4. |
| `--size` | For example `1280x720`. Many models render only a few sizes and lengths; a mismatch is routed to another offer. |
| `--cap-usd` | Sends `x-liquid-cap-usd`. |
| `--timeout` | Seconds to wait, default 900. On timeout the job may still finish; poll its id. |
| `--output` | File path, default `video.mp4`. |

The script polls every 5 seconds until `completed` or `failed`, then downloads the file and prints the job id and the length the exchange used.

`input_reference` (video from an image) is refused with `400 unsupported_content`. The body may be JSON or `multipart/form-data`; the script sends JSON. A router model that ranks by price cannot buy video.

## Status

Discovery was run against the live exchange. The create, poll and download flow was written from the docs and not run, because it spends money.
