# Python provider reference

Code: [`providers/python/provider.py`](../../providers/python/provider.py). Run steps and settings: [`providers/python/README.md`](../../providers/python/README.md). Protocol: [wire protocol](wire-protocol.md).

The file is one module of about 790 lines, with `aiohttp` for the WebSocket and the dispatch server, the `openai` client for the upstream, and SQLite for the award journal.

## What to read in it

**Quote only the selected deployment.** The quote carries an execution reference and the token limits of the listed model. The agent re-quotes at half the accepted lifetime, measured on monotonic time, so a wall-clock jump does not move the deadline. Each quote bumps `revision`, and the agent remembers which revision it sent so it can match `quote_ack` and `quote_reject`.

**Claim the award before upstream work.** A SQLite insert (`INSERT OR IGNORE`) commits the claim before the upstream request. A repeated award id gets `409 duplicate_award`, even if the payload differs. The upstream client has retries disabled, so one award means at most one upstream call.

**Report native usage.** The agent separates cached input from uncached input and passes the upstream usage object through in `raw`. It estimates nothing and calculates no charge. It rejects usage it cannot map: cached tokens above the total, reasoning tokens, cache writes.

## Recovery

- A WebSocket disconnect removes your quotes from the book. The agent reconnects with backoff and uses the new `listed` frame.
- An active dispatch keeps running while the session reconnects.
- Ctrl-C stops quoting first, then lets active dispatches finish within the shutdown timeout.
- Keep the SQLite file across restarts. After a crash, an award with an unknown upstream result is refused, not resumed. Deleting the database to retry can repeat upstream work.

This reference makes no production reliability guarantee.

## Troubleshooting

| Symptom | Repair |
| --- | --- |
| `login_reject` | Check admission, the provider key, the handle and the registered endpoint. |
| `listed` without your deployment | Check the exact deployment name, pause state and suspension. |
| `quote_reject` | Use its `code` and `field`. |
| Accepted quote, no jobs | Check the buyer's model, features, retention policy, deadline and cap against your quote. |
| `journal_unavailable` | Check file permissions and SQLite locks. Keep the database. |
| `duplicate_award` | Do not resend. Check the job's receipt. |
| `dispatch_failed` | Check upstream availability, final usage and timeout. |
| Missing final usage | Use an upstream that returns native usage. |
