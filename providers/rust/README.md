# Rust provider reference

A small provider agent for Liquid Inference. It serves one text deployment from
any OpenAI-compatible upstream. It is a port of the Python reference
(`providers/python`) and follows the same behavior.

Status: the tests pass offline against a fake exchange and a fake upstream.
This agent has **not yet been run against a live router**. Treat the wire
details as unverified until it has been.

## How it works

1. The agent opens `wss://<exchange>/v1/provider/ws` and sends `login`.
2. It reads `login_ack` and `listed`. It picks the listed deployment whose
   `deployment_name` equals `LIQUID_DEPLOYMENT_NAME`.
3. It sends one `quote` with a `revision` that increases in the session. It
   quotes again at half of the accepted `valid_for_ms`, before the quote expires.
4. The exchange sends `award_notice` on the session. It then posts the job to
   `LIQUID_DISPATCH_URL`.
5. The agent checks the job against the notice and against its own quote. It
   writes the claim for the award id to disk. Only then does it call the
   upstream.
6. It streams `application/x-ndjson` back: `delta` events, then `done` with the
   usage meters, or `failed`. The exchange settles on `done` and sends
   `settlement_notice`.

| Module | Job |
|---|---|
| `protocol` | The frames, as serde types with `#[serde(tag = "type")]`. |
| `session` | Login, quotes, re-quotes, heartbeats, reconnect with backoff (0.25 s, doubling to 5 s). |
| `dispatch` | The axum endpoint: checks, idempotency, streaming. |
| `journal` | The award claims on disk. |
| `upstream` | The streaming call and the usage mapping. |
| `config` | Settings from environment variables. |

Rules the agent keeps:

- A second delivery of an award gets `409 {"error":"duplicate_award"}` and starts
  no upstream work. The claim is durable, so this holds after a restart.
- A dispatch that does not match its award, or asks for a feature the quote did
  not declare, gets `400 invalid_dispatch` and is not claimed.
- The upstream's `cached_tokens` go to the `cache_read` meter and the rest of the
  prompt to `uncached_input`. Each token counts in one meter.
- An upstream error, a tool call, reasoning output, or a stream with no usage
  gives a `failed` event.
- On shutdown the agent sends `mass_withdraw`, closes the session, and finishes
  the dispatches in progress before it exits.

## Run

You need Rust 1.91 or newer, a provider key, a deployment registered in the
provider console, and a public HTTPS address that reaches the dispatch listener.

```bash
export LIQUID_PROVIDER_SLUG=your-provider
export LIQUID_PROVIDER_API_KEY=sk-liquid-...
export LIQUID_DEPLOYMENT_NAME=your-deployment
export LIQUID_DISPATCH_URL=https://provider.example.com/dispatch
export LIQUID_UPSTREAM_BASE_URL=http://127.0.0.1:9200/v1
export LIQUID_UPSTREAM_API_KEY=replace-with-upstream-key
export LIQUID_RATE_INPUT=0.10
export LIQUID_RATE_CACHE_READ=0.02
export LIQUID_RATE_OUTPUT=0.20
cargo run --release
```

Set `RUST_LOG=debug` for more logs. `GET /health` reports whether the session is
open. Send `SIGTERM` or `Ctrl-C` to stop the agent.

## Configuration

All names start with `LIQUID_`. Rates are USD per million tokens, with at most
nine decimal places.

| Variable | Required | Default | Meaning |
|---|---|---|---|
| `EXCHANGE_URL` | no | `https://router.inference.ai.exchange` | The exchange. `https` becomes `wss` for the session. |
| `PROVIDER_SLUG` | yes | | Your provider handle. |
| `PROVIDER_API_KEY` | yes | | Your provider key. |
| `DEPLOYMENT_NAME` | yes | | The `deployment_name` in the `listed` frame, without the provider slug. |
| `DISPATCH_URL` | yes | | Where the exchange posts jobs. Scheme, host and port must match the registered endpoint. |
| `DISPATCH_BIND` | no | `127.0.0.1:9110` | The local listener address. |
| `UPSTREAM_BASE_URL` | yes | | An OpenAI-compatible base URL, such as `http://127.0.0.1:9200/v1`. |
| `UPSTREAM_API_KEY` | yes | | Sent as a bearer token to the upstream. |
| `RATE_INPUT` | yes | | Price of uncached input. |
| `RATE_CACHE_READ` | yes | | Price of cached input. Use the input rate if the upstream has no cache price. |
| `RATE_OUTPUT` | yes | | Price of generated tokens. |
| `RETENTION_POLICY` | no | `none` | `none` or `allowed`. |
| `AWARD_JOURNAL` | no | `awards.journal` | The file that holds the award claims. Keep it across restarts. |
| `QUOTE_LIFETIME_MS` | no | `60000` | `valid_for_ms` of each quote, up to `600000`. |
| `UPSTREAM_TIMEOUT_SECONDS` | no | `30` | Connect and read timeout for the upstream. |
| `SHUTDOWN_TIMEOUT_SECONDS` | no | `35` | How long to wait for dispatches at shutdown. |

The upstream model name comes from the `model` field of the `listed` frame, so
there is no separate model setting.

## Test

```bash
cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test
```

The tests need no network. They start a fake exchange WebSocket and a fake
upstream on loopback ports. They cover login, the quote, re-quotes, reconnect,
award and dispatch, duplicate awards, usage meters, upstream failure, shutdown
with a dispatch in progress, and the dispatch checks.

## What is and is not covered

Covered:

- Text chat on one deployment, with token prices: `rate_uncached_input`,
  `rate_cache_read` and `rate_generation`.
- The `text` feature only. The quote declares nothing else.

Not covered:

- Image, speech and video deployments.
- Tools, `response_format`, sampling parameters beyond `temperature`, log
  probabilities, reasoning, attachments and prompt-cache breakpoints. The agent
  refuses a dispatch that needs one.
- Cache write prices and reasoning meters. The agent fails a job whose upstream
  reports cache writes or reasoning tokens.
- The `handover` capability. The agent logs in with no capabilities, holds one
  session, and ignores `handover`. Without the capability, a new release of the
  exchange closes the session and the agent connects again, so the offers leave
  the book for a moment.
- Several deployments or several upstreams. Run one agent for each deployment
  only if you register one provider for each, because a second login for the
  same provider replaces the first session.
- Anything verified against a live router.
