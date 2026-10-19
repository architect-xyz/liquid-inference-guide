# TypeScript provider reference

Code: [`providers/typescript`](../../providers/typescript). Run steps and settings: its [README](../../providers/typescript/README.md). Protocol: [wire protocol](wire-protocol.md).

A port of the [Python reference](python.md) for one text deployment. Node 22 or later. The only runtime dependency is `ws`; the dispatch server uses `node:http` and the upstream client uses global `fetch`.

Status: `npm run typecheck` (strict, no `any`) and `npm test` (54 tests against a fake exchange and a fake upstream) pass. It has not been run against a live router.

## Module map

| File | Job |
| --- | --- |
| `src/protocol.ts` | Frame types and a validating parser for exchange frames. |
| `src/session.ts` | Login, quotes with a rising revision, re-quote at half the accepted lifetime on a monotonic clock, heartbeat, reconnect backoff (0.25 s doubling to 5 s), standby after `superseded`. |
| `src/dispatch.ts` | HTTP server: validates the dispatch, claims the award, streams ndjson, drains in-flight jobs on shutdown. |
| `src/upstream.ts` | Streaming client for an OpenAI-compatible upstream. |
| `src/usage.ts` | Maps upstream usage to meters: cached tokens to `cache_read`, the rest to `uncached_input`. Rejects reasoning tokens and cache writes. |
| `src/journal.ts` | Append-only award journal with fsync. |

## Differences from the Python reference

- The journal is an append-only file, not SQLite.
- Env names: `LIQUID_PROVIDER_KEY` and `LIQUID_AWARD_JOURNAL` (Python: `LIQUID_PROVIDER_API_KEY`, `LIQUID_AWARD_DB`).
- A `listed` entry that is not a text token deployment is logged and skipped. Python raises and restarts the session.
- A `failed` event for an upstream HTTP error starts with `upstream returned <status>: <body>`, as the dispatch docs require.
- The login sends `capabilities: []`. There is no handover.

## Open protocol questions

The sources disagree or are silent on these. Both ports copy the Python reference.

- `listed` entries: the quoting docs show `model_deployment`; the Rust protocol types and Python use `deployment_name`. The TypeScript parser accepts either.
- `execution_ref` and `execution_limits` appear in the Python quote and dispatch but not in the wire docs.
- A dispatch can arrive before its `award_notice` is processed. The agent waits up to 2 s, then answers 400.
- The status for `max_output_tokens` of 0 or above the limit is not documented. The agent answers 400 `invalid_dispatch`.
