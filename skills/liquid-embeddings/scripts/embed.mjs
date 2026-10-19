// Embeds texts with POST /v1/embeddings and prints a summary.
// Usage: node embed.mjs --model <id> "text one" "text two" [--output vectors.json] [--cap-usd 0.01]
import { writeFile } from 'node:fs/promises'
import { ORIGIN, capHeaders, failOnError, parseArgs, requireKey } from './lib.mjs'

const { flags, positional } = parseArgs(process.argv.slice(2))
if (!flags.model || positional.length === 0) {
  console.error('usage: embed.mjs --model <id> "text" ["text" ...] [--output vectors.json] [--cap-usd 0.01]')
  process.exit(2)
}
if (positional.length > 2048) {
  console.error('a request holds at most 2,048 texts')
  process.exit(2)
}
const res = await fetch(`${ORIGIN}/v1/embeddings`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${requireKey()}`,
    'Content-Type': 'application/json',
    ...capHeaders(flags),
  },
  body: JSON.stringify({ model: flags.model, input: positional }),
})
await failOnError(res)
const json = await res.json()
if (flags.output) await writeFile(String(flags.output), JSON.stringify(json.data))
console.log(
  JSON.stringify(
    {
      model: json.model,
      count: json.data.length,
      dimensions: json.data[0]?.embedding.length,
      usage: json.usage,
      exchange: json.exchange,
      vectors_saved: flags.output ?? null,
    },
    null,
    2,
  ),
)
