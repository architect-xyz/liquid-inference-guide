// Generates images with POST /v1/images/generations and saves them to disk.
// Usage: node generate.mjs "prompt" --model <id> [--n 1] [--size 1024x1024]
//        [--response-format b64_json|url] [--output out.png] [--cap-usd 0.10]
import { writeFile } from 'node:fs/promises'
import { ORIGIN, capHeaders, failOnError, parseArgs, requireKey } from './lib.mjs'

const { flags, positional } = parseArgs(process.argv.slice(2))
const prompt = positional[0]
if (!prompt || !flags.model) {
  console.error('usage: generate.mjs "prompt" --model <id> [--n 1] [--size WxH] [--response-format b64_json|url] [--output file] [--cap-usd 0.10]')
  process.exit(2)
}
const body = { model: flags.model, prompt }
if (flags.n) body.n = Number(flags.n)
if (flags.size) body.size = flags.size
if (flags['response-format']) body.response_format = flags['response-format']

const res = await fetch(`${ORIGIN}/v1/images/generations`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${requireKey()}`,
    'Content-Type': 'application/json',
    ...capHeaders(flags),
  },
  body: JSON.stringify(body),
})
await failOnError(res)
const json = await res.json()

const base = String(flags.output ?? 'image.png')
const dot = base.lastIndexOf('.')
const stem = dot > 0 ? base.slice(0, dot) : base
const ext = dot > 0 ? base.slice(dot) : '.png'
const saved = []
for (const [i, item] of json.data.entries()) {
  const path = json.data.length > 1 ? `${stem}-${i + 1}${ext}` : base
  if (item.b64_json) await writeFile(path, Buffer.from(item.b64_json, 'base64'))
  else if (item.url) await writeFile(path, Buffer.from(await (await fetch(item.url)).arrayBuffer()))
  else continue
  saved.push(path)
}
console.log(JSON.stringify({ model: flags.model, prompt, images_saved: saved, count: saved.length, exchange: json.exchange }, null, 2))
