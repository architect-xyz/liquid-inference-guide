// Renders a video: POST /v1/videos, poll GET /v1/videos/{id}, download /content.
// Usage: node generate.mjs "prompt" --model <id> [--seconds 5] [--size 1280x720]
//        [--output video.mp4] [--cap-usd 1.00] [--timeout 900]
import { writeFile } from 'node:fs/promises'
import { ORIGIN, capHeaders, failOnError, parseArgs, requireKey } from './lib.mjs'

const { flags, positional } = parseArgs(process.argv.slice(2))
const prompt = positional[0]
if (!prompt || !flags.model) {
  console.error('usage: generate.mjs "prompt" --model <id> [--seconds 5] [--size WxH] [--output file] [--cap-usd 1.00] [--timeout 900]')
  process.exit(2)
}
const auth = { Authorization: `Bearer ${requireKey()}` }
const body = { model: flags.model, prompt }
if (flags.seconds) body.seconds = String(flags.seconds)
if (flags.size) body.size = flags.size

const create = await fetch(`${ORIGIN}/v1/videos`, {
  method: 'POST',
  headers: { ...auth, 'Content-Type': 'application/json', ...capHeaders(flags) },
  body: JSON.stringify(body),
})
await failOnError(create)
const job = await create.json()
console.error(`job ${job.id} accepted, cap ${create.headers.get('x-liquid-cap-usd')} USD`)

const deadline = Date.now() + Number(flags.timeout ?? 900) * 1000
let status = job
while (status.status !== 'completed' && status.status !== 'failed') {
  if (Date.now() > deadline) {
    console.error(`timed out; job ${job.id} may still finish. Poll GET /v1/videos/${job.id}`)
    process.exit(1)
  }
  await new Promise((r) => setTimeout(r, 5000))
  const poll = await fetch(`${ORIGIN}/v1/videos/${job.id}`, { headers: auth })
  await failOnError(poll)
  status = await poll.json()
}
if (status.status === 'failed') {
  console.error(`render failed: ${JSON.stringify(status).slice(0, 600)}`)
  process.exit(1)
}

const content = await fetch(`${ORIGIN}/v1/videos/${job.id}/content`, { headers: auth })
await failOnError(content)
const output = String(flags.output ?? 'video.mp4')
await writeFile(output, Buffer.from(await content.arrayBuffer()))
console.log(JSON.stringify({ model: flags.model, job_id: job.id, video_saved: output, seconds: status.seconds }, null, 2))
