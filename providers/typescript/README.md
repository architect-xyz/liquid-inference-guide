# Liquid Inference provider reference (TypeScript)

A small provider agent for one text deployment. It ports the behavior of the
Python reference (`py/provider-reference`) to TypeScript.

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
   `delta` lines, then `done` with the usage meters, or `failed`.
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
`POST /dispatch` and `GET /health` on `LIQUID_DISPATCH_BIND`.

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
| `LIQUID_RATE_INPUT` | yes | | USD per million uncached input tokens. |
| `LIQUID_RATE_CACHE_READ` | yes | | USD per million cached input tokens. Set it even if it equals the input rate. |
| `LIQUID_RATE_OUTPUT` | yes | | USD per million generated tokens. |
| `LIQUID_RETENTION_POLICY` | yes | | `none` or `allowed`. The agent does not enforce it. |
| `LIQUID_AWARD_JOURNAL` | yes | | Path of the award journal file. Keep it across restarts. |
| `LIQUID_QUOTE_LIFETIME_MS` | no | `60000` | `valid_for_ms` of each quote, 1 to 600000. |
| `LIQUID_UPSTREAM_TIMEOUT_SECONDS` | no | `30` | Longest wait for the next byte from the upstream, 1 to 3600. |
| `LIQUID_SHUTDOWN_TIMEOUT_SECONDS` | no | `35` | Time to finish dispatches in progress at shutdown, 1 to 3600. |

Rates are decimal strings with at most nine decimal places. The agent passes
them to the quote as JSON numbers and does no arithmetic on them. It reports
only integer token meters. The exchange computes every charge.

## Layout

| File | Role |
| --- | --- |
| `src/protocol.ts` | Frame types and the parser for frames from the exchange. |
| `src/session.ts` | Session client: login, quote, revision counter, re-quote, reconnect, awards. |
| `src/dispatch.ts` | Dispatch HTTP server: validation, claim, ndjson streaming, shutdown drain. |
| `src/upstream.ts` | Streaming client for an OpenAI-compatible upstream. |
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

Not covered:

- Text chat deployments only. No image, speech or video, and no `/content`
  endpoint for video downloads.
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
- A `listed` entry for a deployment that is not a text deployment priced in
  tokens is logged and not quoted. The Python reference raises an error and
  restarts the session.
- A `failed` event for an upstream HTTP error starts its message with
  `upstream returned <status>: ` and the upstream body, as the dispatch docs
  describe. The Python reference sends a fixed message.
