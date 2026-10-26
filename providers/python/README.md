# Python provider reference

`provider.py` serves one deployment, text, image, speech or video, through an OpenAI-compatible upstream. It is a single file by design: copy it, do not import from it. It is a verbatim copy of the file that Liquid Inference tests against a real router (version 0.2.0). The dependencies are in the `# /// script` header, which `uv` reads.

Requirements: Python 3.12 or later and [uv](https://docs.astral.sh/uv/). Your upstream must support streamed Chat Completions with `stream_options.include_usage` and return input and output token counts in the final usage object. If a stream stops early, the final usage can be absent and the reference reports failure.

## Before you start

1. Apply as a provider and wait for admission.
2. Issue a provider key.
3. Register your deployment.

See [the provider overview](../../docs/providers/README.md). The reference does not register or list a deployment. It picks your deployment by name from the current `listed` frame.

## Run

Create `.env.local` next to `provider.py`. Do not commit it.

```bash
LIQUID_EXCHANGE_URL=https://router.inference.ai.exchange
LIQUID_PROVIDER_SLUG=your-provider
LIQUID_PROVIDER_API_KEY=replace-with-provider-key
LIQUID_DEPLOYMENT_NAME=your-deployment
LIQUID_DISPATCH_BIND=127.0.0.1:9110
LIQUID_DISPATCH_URL=https://provider.example.com/dispatch
LIQUID_UPSTREAM_BASE_URL=http://127.0.0.1:9200/v1
LIQUID_UPSTREAM_API_KEY=replace-with-upstream-key
LIQUID_RATE_INPUT=0.10
LIQUID_RATE_CACHE_READ=0.02
LIQUID_RATE_OUTPUT=0.20
LIQUID_RETENTION_POLICY=allowed
LIQUID_AWARD_DB=awards.sqlite3
```

```bash
set -a
source .env.local
set +a
uv run provider.py
```

| Variable | Meaning |
| --- | --- |
| `LIQUID_DEPLOYMENT_KIND` | Optional. `chat` (default), `image_generation`, `audio_speech` or `video_generation`. The listed deployment must have the same kind, or the agent does not quote it. |
| `LIQUID_RATE_INPUT`, `LIQUID_RATE_CACHE_READ`, `LIQUID_RATE_OUTPUT` | Chat only. USD per million tokens. Set the cache-read price explicitly, even if it equals the input price. |
| `LIQUID_RATE_PER_IMAGE`, `LIQUID_RATE_PER_CHARACTER`, `LIQUID_RATE_PER_VIDEO_SECOND` | USD per unit, for the image, speech and video kinds. Set the one that matches the kind. Non-negative, at most nine decimal places. The quote carries only that rate. |
| `LIQUID_COMPLETION_MS` | Optional. The time in which a media job commits to finish. Defaults 90000 for image, 30000 for speech, 300000 for video. |
| `LIQUID_CONTENT_KEY` | Video only, required. The secret that signs the download token of each finished video. |
| `LIQUID_UPSTREAM_POLL_SECONDS`, `LIQUID_UPSTREAM_RENDER_TIMEOUT_SECONDS` | Video only, optional. How often to ask the upstream about a render, and when to give up. Defaults 2 and 540. |
| `LIQUID_RETENTION_POLICY` | `allowed` if your upstream can retain buyer data; `none` only if it guarantees no retention. The reference does not enforce this. |
| `LIQUID_DISPATCH_URL` | Reachable from the exchange. Scheme, host and port must match your registered endpoint. |
| `LIQUID_DISPATCH_BIND` | The local listener. Not necessarily public. |
| `LIQUID_AWARD_DB` | SQLite file that records award ids. Relative paths start at the current directory. |
| `LIQUID_QUOTE_LIFETIME_MS`, `LIQUID_UPSTREAM_TIMEOUT_SECONDS`, `LIQUID_SHUTDOWN_TIMEOUT_SECONDS` | Optional. Defaults 60000, 30, 35. |

A chat quote promises a first token within 1,500 ms and completion within 30,000 ms. A media quote promises the one `LIQUID_COMPLETION_MS` for both. Use an upstream that can meet these deadlines.

The upstream for a media kind is the OpenAI-compatible endpoint of that kind: `/images/generations`, `/audio/speech`, or `/videos` with `/videos/{id}` and `/videos/{id}/content`. A video deployment also serves `POST /content`, where the exchange fetches the finished file with the signed token. The agent registers that route only for video, so `LIQUID_DISPATCH_URL` must be reachable for it too.

The agent logs in with the `handover` capability. A new agent started next to an old one takes over the quotes with no gap; the old agent gets `superseded`, finishes its jobs and does not reconnect.

## Check it works

Send a small buyer request from a funded workspace that can reach the deployment:

```bash
curl "$LIQUID_EXCHANGE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $LIQUID_API_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model":"your-provider/your-deployment","max_tokens":32,
       "messages":[{"role":"user","content":"Say hello."}],
       "exchange":{"allow_single_supplier":true,
                   "retention_policy":"allowed","cap_usd":0.001}}'
```

This can incur an upstream charge. Read the receipt at `/v1/exchange/jobs/<job_id>`; `settlement_status: settled` means the exchange accepted the usage.

## Behaviors worth copying

- Quote only the deployment in the current `listed` frame.
- Claim the award id before any upstream work. A repeated delivery gets `409 {"error":"duplicate_award"}`.
- Report the upstream's native usage, including cached tokens, as meters.

## Updates

This copy is not generated from the source in this repository. If the upstream reference changes, replace `provider.py` and update the version noted above.
