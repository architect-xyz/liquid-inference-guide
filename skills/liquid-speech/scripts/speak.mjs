// Synthesizes speech with POST /v1/audio/speech and saves the audio.
// Usage: node speak.mjs "text" --model <id> --voice <voice> [--format mp3] [--speed 1.0]
//        [--output speech.mp3] [--cap-usd 0.05]
import { writeFile } from 'node:fs/promises'
import { ORIGIN, capHeaders, failOnError, parseArgs, requireKey } from './lib.mjs'

const { flags, positional } = parseArgs(process.argv.slice(2))
const input = positional[0]
if (!input || !flags.model || !flags.voice) {
  console.error('usage: speak.mjs "text" --model <id> --voice <voice> [--format mp3] [--speed 1.0] [--output file] [--cap-usd 0.05]')
  process.exit(2)
}
if ([...input].length > 4096) {
  console.error('input is over 4,096 characters')
  process.exit(2)
}
const format = String(flags.format ?? 'mp3')
const body = { model: flags.model, input, voice: flags.voice, response_format: format }
if (flags.speed) body.speed = Number(flags.speed)

const res = await fetch(`${ORIGIN}/v1/audio/speech`, {
  method: 'POST',
  headers: {
    Authorization: `Bearer ${requireKey()}`,
    'Content-Type': 'application/json',
    ...capHeaders(flags),
  },
  body: JSON.stringify(body),
})
await failOnError(res)
const output = String(flags.output ?? `speech.${format}`)
await writeFile(output, Buffer.from(await res.arrayBuffer()))
console.log(
  JSON.stringify(
    {
      model: flags.model,
      audio_saved: output,
      job_id: res.headers.get('x-liquid-job-id'),
      cap_usd: res.headers.get('x-liquid-cap-usd'),
      exchange: res.headers.get('x-liquid-exchange'),
    },
    null,
    2,
  ),
)
