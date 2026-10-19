// Lists models of kind "embedding" from the public /v1/models endpoint (no key needed).
// Usage: node discover.mjs [model-id]
import { listModels, parseArgs } from './lib.mjs'

const { positional } = parseArgs(process.argv.slice(2))
const models = await listModels('embedding')
if (positional[0]) {
  const m = models.find((x) => x.id === positional[0])
  if (!m) {
    console.error(`no embedding model named ${positional[0]}; run without arguments to list them`)
    process.exit(1)
  }
  console.log(JSON.stringify(m, null, 2))
} else {
  console.log(JSON.stringify(models.map((m) => ({ id: m.id, ...pick(m) })), null, 2))
}

function pick(m) {
  const out = {}
  for (const k of ['max_input_tokens', 'min_input_rate']) if (m[k] !== undefined) out[k] = m[k]
  return out
}
