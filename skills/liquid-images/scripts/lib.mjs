export const ORIGIN = process.env.LIQUID_ORIGIN ?? 'https://router.inference.ai.exchange'

export function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) flags[key] = true
      else {
        flags[key] = next
        i++
      }
    } else positional.push(a)
  }
  return { flags, positional }
}

export function requireKey() {
  const key = process.env.LIQUID_API_KEY
  if (!key) {
    console.error('LIQUID_API_KEY is not set. Export a spend key first.')
    process.exit(2)
  }
  return key
}

export function capHeaders(flags) {
  return flags['cap-usd'] ? { 'x-liquid-cap-usd': String(flags['cap-usd']) } : {}
}

export async function failOnError(res) {
  if (res.ok) return
  const text = await res.text()
  let code = ''
  try {
    code = JSON.parse(text).error?.code ?? ''
  } catch {}
  console.error(`HTTP ${res.status}${code ? ` ${code}` : ''}: ${text.slice(0, 600)}`)
  process.exit(1)
}

export async function listModels(kind) {
  const res = await fetch(`${ORIGIN}/v1/models`)
  await failOnError(res)
  const body = await res.json()
  return body.data.filter((m) => (m.kind ?? 'chat') === kind)
}
