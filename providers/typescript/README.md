# Liquid Inference provider reference (TypeScript)

A small provider agent for one deployment: text, image, speech or video. It ports
the behavior of the Python reference (`py/provider-reference`, version 0.2.0) to
TypeScript.

Status: the tests run offline against a fake exchange and a fake upstream. This
agent has **not yet been run against a live router**.

## What it does

1. Opens a WebSocket session to `<exchange>/v1/provider/ws` and sends `login`.
2. Reads `login_ack` and `listed`. It picks the deployment whose
   `deployment_name` equals `LIQUID_DEPLOYMENT_NAME`.
3. Sends one `quote` with a per-session `revision`. It quotes again at half of
   the accepted `valid_for_ms`, measured on a monotonic clock, and sends a
   `heartbeat` at least every second.
4. Stores each `award_notice`. When the exchange posts the job to `/dispatch`,
   it checks the job against the notice and the acknowledged quote.
5. Claims the award in an append-only journal that is flushed to disk. This
   happens **before** any upstream request. A repeat gets `409
   {"error":"duplicate_award"}`.
6. Streams the job from an OpenAI-compatible upstream (`/chat/completions`, with
   `stream_options.include_usage`) and writes `application/x-ndjson` events:
   `delta` lines, then `done` with the usage meters, or `failed`. A media
   deployment calls the upstream endpoint of its kind instead; see
   [Deployment kinds](#deployment-kinds).
7. On `SIGINT` or `SIGTERM`, sends `mass_withdraw`, closes the session, refuses
   new dispatches and waits for the dispatches in progress.

## Run

You need Node 22 or later, an admitted provider with a registered deployment, and
an upstream with streamed Chat Completions.

```bash
npm install
npm run typecheck
npm test
npm run build
```

Put the settings in a file named `.env.local`, and do not commit it:

```bash
LIQUID_EXCHANGE_URL=https://router.inference.ai.exchange
LIQUID_PROVIDER_SLUG=your-provider
LIQUID_PROVIDER_KEY=replace-with-provider-key
LIQUID_DEPLOYMENT_NAME=your-deployment
LIQUID_DISPATCH_BIND=127.0.0.1:9110
LIQUID_DISPATCH_URL=https://provider.example.com/dispatch
LIQUID_UPSTREAM_BASE_URL=http://127.0.0.1:9200/v1
LIQUID_UPSTREAM_API_KEY=replace-with-upstream-key
LIQUID_DEPLOYMENT_KIND=chat
LIQUID_RATE_INPUT=0.10
LIQUID_RATE_CACHE_READ=0.02
LIQUID_RATE_OUTPUT=0.20
LIQUID_RETENTION_POLICY=allowed
LIQUID_AWARD_JOURNAL=awards.journal
```

Then start the agent:

```bash
set -a; source .env.local; set +a
npm start          # builds, then runs node dist/main.js
```

`LIQUID_DISPATCH_URL` must be reachable from the exchange. Its scheme, host and
port must match the `declared_endpoint` of your provider. The agent serves
`POST /dispatch` and `GET /health` on `LIQUID_DISPATCH_BIND`, and `POST /content`
for a video deployment.

## Configuration

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `LIQUID_EXCHANGE_URL` | yes | | HTTP(S) address of the exchange. The session uses `wss://` or `ws://` with `/v1/provider/ws`. |
| `LIQUID_PROVIDER_SLUG` | yes | | Your current provider handle. |
| `LIQUID_PROVIDER_KEY` | yes | | Provider credential. Sent in `login` only. Never logged. |
| `LIQUID_DEPLOYMENT_NAME` | yes | | `deployment_name` of the registered deployment to quote. The upstream model id, tokenizer and limits come from the `listed` frame. |
| `LIQUID_DISPATCH_BIND` | yes | | `host:port` for the local HTTP listener. Port `0` picks a free port. |
| `LIQUID_DISPATCH_URL` | yes | | Public URL the exchange posts jobs to. Sent in `login`. |
| `LIQUID_UPSTREAM_BASE_URL` | yes | | Base URL of the OpenAI-compatible upstream, such as `http://127.0.0.1:9200/v1`. |
| `LIQUID_UPSTREAM_API_KEY` | yes | | Bearer key for the upstream. |
| `LIQUID_DEPLOYMENT_KIND` | no | `chat` | `chat`, `image_generation`, `audio_speech` or `video_generation`. Any other value is a configuration error. The listed deployment must have the same kind, or the agent does not quote it. |
| `LIQUID_RATE_INPUT` | chat | | USD per million uncached input tokens. |
| `LIQUID_RATE_CACHE_READ` | chat | | USD per million cached input tokens. Set it even if it equals the input rate. |
| `LIQUID_RATE_OUTPUT` | chat | | USD per million generated tokens. |
| `LIQUID_RATE_PER_IMAGE` | image | | USD per image. |
| `LIQUID_RATE_PER_CHARACTER` | speech | | USD per character of the text. |
| `LIQUID_RATE_PER_VIDEO_SECOND` | video | | USD per second of video. |
| `LIQUID_COMPLETION_MS` | no | `90000` image, `30000` speech, `300000` video | The time in which a media job commits to finish. The quote uses it for `ttft_ms` and `completion_ms`. |
| `LIQUID_CONTENT_KEY` | video | | Secret that signs the download token of each finished video. An empty value is a configuration error for video. |
| `LIQUID_UPSTREAM_POLL_SECONDS` | no | `2` | Video only. Time between two questions to the upstream about a render, more than 0 and at most 3600. |
| `LIQUID_UPSTREAM_RENDER_TIMEOUT_SECONDS` | no | `540` | Video only. The agent fails the job when the render takes longer, more than 0 and at most 3600. |
| `LIQUID_RETENTION_POLICY` | yes | | `none` or `allowed`. The agent does not enforce it. |
| `LIQUID_AWARD_JOURNAL` | yes | | Path of the award journal file. Keep it across restarts. |
| `LIQUID_QUOTE_LIFETIME_MS` | no | `60000` | `valid_for_ms` of each quote, 1 to 600000. |
| `LIQUID_UPSTREAM_TIMEOUT_SECONDS` | no | `30` | Longest wait for the next byte from the upstream, 1 to 3600. |
| `LIQUID_SHUTDOWN_TIMEOUT_SECONDS` | no | `35` | Time to finish dispatches in progress at shutdown, 1 to 3600. |

Rates are decimal strings with at most nine decimal places. The agent passes
them to the quote as JSON numbers and does no arithmetic on them. It reports
only integer meters. The exchange computes every charge. A chat deployment
needs the three token rates and no unit rate. A media deployment needs the one
unit rate of its kind and no token rates.

## Deployment kinds

| Kind | Upstream call | Events | `done` meters |
| --- | --- | --- | --- |
| `chat` | `POST /chat/completions`, streamed | `delta` | The token meters of the upstream usage. |
| `image_generation` | `POST /images/generations` with `model`, `prompt`, `n`, and `size`, `output_format`, `quality`, `response_format` when set | One `image` for each entry with `b64_json` or `url` | `{images: sent}` |
| `audio_speech` | `POST /audio/speech` with `model`, `input`, `voice`, and `response_format`, `speed` when set | One `audio` with the clip and the `Content-Type` that came back | `{characters: <length of the text>}` |
| `video_generation` | `POST /videos`, then `GET /videos/{id}` until the render ends, then `GET /videos/{id}/content` | `video_ready` with a handle and a token | `{video_seconds: <requested>}` |

A media quote carries the one rate of its kind, `supported_features: ["text"]`,
and a `service_class` with the same time for `ttft_ms` and `completion_ms`. The
prompt of a media job is the last user message. The agent does not apply the
output-token limit to a media job. It requires the bound object of the kind
(`image`, `audio` or `video`) and answers 400 without upstream work when it is
missing. A chat deployment refuses those objects.

A media `done` event has `finish_reason: "stop"`, the meters of its kind, the
listed `tokenizer_id` (or `provider-native`) and an empty `raw`. A failed job
ends with `failed` and never with `done`. An image job fails when the upstream
returns no image or more than `count`. A speech job fails on an empty clip.

A video render can outlast a quiet connection, so the agent writes a blank line to
the stream on each poll. It fails the job when the render ends in any state other
than `completed`, or after `LIQUID_UPSTREAM_RENDER_TIMEOUT_SECONDS`. Before it
reports the video it requests the file and checks the status, a `video/*`
content type and a non-zero length. `video_ready` carries the upstream id as
`handle`, the hex HMAC-SHA256 of the handle under `LIQUID_CONTENT_KEY` as
`token`, and `mime`, `bytes` and `expires_at` when the upstream states them.
The exchange fetches the file with `POST /content` and `{handle, token}`. The
agent compares the token in constant time, answers 403 for a wrong token or a
handle with `/`, `?` or `#`, and streams the upstream file with its
`Content-Type`.

## Layout

| File | Role |
| --- | --- |
| `src/protocol.ts` | Frame types and the parser for frames from the exchange. |
| `src/session.ts` | Session client: login, quote, revision counter, re-quote, reconnect, awards. |
| `src/dispatch.ts` | Dispatch HTTP server: validation, claim, ndjson streaming, shutdown drain. |
| `src/upstream.ts` | Streaming client for an OpenAI-compatible upstream. |
| `src/media.ts` | Image, speech and video calls, and the signed video handle. |
| `src/usage.ts` | Native usage to meters, including cached tokens. |
| `src/journal.ts` | Append-only award journal, flushed before upstream work. |
| `src/config.ts` | Settings from environment variables. |
| `test/` | Offline tests: fake exchange (`ws`), fake upstream (`node:http`). |

## What is and is not covered

Covered, and tested offline:

- Login, `listed`, `quote`, `quote_ack`, `quote_reject` (including `superseded`),
  `withdraw_quote`, `mass_withdraw`, `heartbeat`, `award_notice`,
  `settlement_notice`, `risk_notice`.
- Reconnect with a wait of 0.25 seconds that doubles to 5 seconds, and
  revisions that restart at 1 on each new session.
- Re-quote before expiry, at half of the accepted lifetime.
- Dispatch checks: `idempotency-key` equals `award_id`; the job matches the
  award notice; `execution_ref` names a quote that the exchange acknowledged;
  the output limit; and no unsupported field.
- Award claim before upstream work; `409 duplicate_award` for a repeat, also
  after a restart and for two concurrent deliveries.
- Usage mapping: cached tokens leave `uncached_input` and go to `cache_read`.
- A `failed` event on an upstream error, a missing usage object, an invalid
  finish reason, a tool call or reasoning in the answer.
- Graceful shutdown that finishes dispatches in progress.
- Media kinds: the quote of each kind, image counting and failure, speech clip
  and empty clip, the full video flow with the token check and the 403 answers,
  a missing bound answered with 400 and no upstream call, and the media
  configuration errors.

Not covered:

- Text, image, speech and video deployments, one kind for each agent. Image
  and speech jobs return their output in the stream. Video returns a handle
  that the exchange fetches from `POST /content`.
- No handover. The login sends `capabilities: []`, so the exchange never sends
  `handover`. A new login for the same provider replaces this session, and the
  offers are absent from the book until the new agent quotes. After `superseded`
  the agent goes to standby and does not log in again.
- No tools, structured output, reasoning, sampling parameters other than
  `temperature`, attachments, prompt-cache breakpoints, or cache writes. The
  agent declares only the `text` feature and refuses a dispatch that needs more.
- One deployment for each agent. No fallback between upstreams.
- Not run against a live router. The wire shapes come from the docs, the Rust
  frame types and the Python reference.

## Differences from the Python reference

- The award journal is an append-only text file, not SQLite. It has the same
  contract: flushed before any upstream request.
- `LIQUID_PROVIDER_KEY` and `LIQUID_AWARD_JOURNAL` replace
  `LIQUID_PROVIDER_API_KEY` and `LIQUID_AWARD_DB`.
- A `listed` entry for a deployment of another kind, or with a pricing unit that
  does not fit the kind, is logged and not quoted. The Python reference raises
  an error and restarts the session.
- A malformed media bound (an image `count` that is not a positive integer, a
  non-string `voice`, `seconds` that is not a positive integer) answers 400
  before the claim. The Python reference fails on it after the claim.
- A `failed` event for an upstream HTTP error starts its message with
  `upstream returned <status>: ` and the upstream body, as the dispatch docs
  describe. The Python reference sends a fixed message.
