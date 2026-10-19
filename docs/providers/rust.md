# Rust provider reference

Code: [`providers/rust`](../../providers/rust). Run steps and settings: its [README](../../providers/rust/README.md). Protocol: [wire protocol](wire-protocol.md).

A standalone crate (`liquid-provider`, edition 2024, empty `[workspace]`) that ports the [Python reference](python.md) for one text deployment. Dependencies: tokio, tokio-tungstenite, axum, reqwest (rustls), serde, anyhow, tracing. Building needs a C toolchain and cmake for `aws-lc-sys`.

Status: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` and `cargo test` (9 unit and 14 offline integration tests against a fake exchange and a fake upstream) pass. It has not been run against a live router.

## Module map

| File | Job |
| --- | --- |
| `src/protocol.rs` | Serde frame types, tagged on `type`. |
| `src/session.rs` | Login, `listed`, quotes with a rising revision (restarts at 1 per connection), re-quote at half the acknowledged lifetime, heartbeat, reconnect backoff (0.25 s doubling to 5 s), standby after `superseded`, `mass_withdraw` on shutdown. |
| `src/dispatch.rs` | axum `/dispatch` and `/health`. Validates against the award notice and quoted snapshot, claims the award first, streams ndjson from a spawned task so graceful shutdown waits for it. |
| `src/upstream.rs` | SSE streaming from an OpenAI-compatible upstream. Maps `cached_tokens` to `cache_read`, the rest of the prompt to `uncached_input`. Refuses reasoning, cache writes, tool calls, and a stream with no usage. |
| `src/journal.rs` | fsync'd append-only file of `provider_id<TAB>award_id`, loaded at startup. |

Status codes: validation errors 400, a duplicate award 409 `{"error":"duplicate_award"}`, a journal failure 503.

## Differences from the Python reference

- The journal is a plain file, not SQLite (`LIQUID_AWARD_JOURNAL`, default `awards.journal`).
- `LIQUID_RETENTION_POLICY` defaults to `none`; `LIQUID_EXCHANGE_URL` defaults to the production router.
- HTTP errors from the upstream become `failed` events starting `upstream returned <status>: <body>`.
- No handover, no image, speech or video.

## Caveat

Rates are `f64` JSON numbers. The env value is checked for at most nine decimals, but how the router parses values such as `0.1` is unverified. See also the open protocol questions in the [TypeScript guide](typescript.md#open-protocol-questions); the same ones apply.
