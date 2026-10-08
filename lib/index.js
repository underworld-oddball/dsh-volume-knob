/**
 * dsh-volume-knob — host half.
 *
 * Serves the system-output volume/mute state the browser half cannot read on
 * its own. In-page media volume is handled entirely by the client bundle, so
 * this half only needs the web server service.
 *
 * macOS  : `osascript` (built in, no extra install)
 * Linux  : `pactl` (pulseaudio/pipewire-pulse), when present
 * other  : reported as unsupported; the widget then hides the system row
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const name = 'dsh-volume-knob'
export const inject = ['webServer']

const NS = 'dsh-volume-knob'
const TIMEOUT_MS = 4000

function sendJson (res, status, payload) {
  res.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
  })
  res.end(JSON.stringify(payload))
}

function readBody (req, limit = 4 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function isLoopback (address) {
  if (!address) return false
  return address === '::1' || address === '127.0.0.1' || address.startsWith('127.') || address.startsWith('::ffff:127.')
}

/** Only the local GUI (or an explicit same-origin page) may change the volume. */
function isTrusted (req) {
  if (!req || !req.headers) return false
  const remote = req.socket?.remoteAddress || req.connection?.remoteAddress
  if (remote && isLoopback(remote)) return true
  const site = req.headers['sec-fetch-site']
  if (site === 'same-origin' || site === 'same-site') return true
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin && host) {
    try {
      if (new URL(origin).host === host) return true
    } catch { /* malformed Origin */ }
  }
  return false
}

const clampVolume = (value) => Math.max(0, Math.min(100, Math.round(Number(value))))

/** Ring buffer of client reports, newest last. */
const diagnostics = []
function record (payload) {
  const entry = {
    at: new Date().toISOString(),
    event: String((payload && payload.event) || 'unknown').slice(0, 80),
    detail: String((payload && payload.detail) === undefined ? '' : payload.detail).slice(0, 800),
  }
  diagnostics.push(entry)
  if (diagnostics.length > 60) diagnostics.shift()
  return entry
}

async function osascript (script) {
  const { stdout } = await run('osascript', ['-e', script], { timeout: TIMEOUT_MS })
  return String(stdout).trim()
}

async function readMac () {
  const out = await osascript('get volume settings')
  const volume = Number(/output volume:(\d+)/u.exec(out)?.[1])
  const muted = /output muted:(true|false)/u.exec(out)?.[1] === 'true'
  if (!Number.isFinite(volume)) throw new Error(`unparsable volume settings: ${out}`)
  return { volume, muted }
}

async function writeMac ({ volume, muted }) {
  if (typeof volume === 'number') await osascript(`set volume output volume ${clampVolume(volume)}`)
  if (typeof muted === 'boolean') await osascript(`set volume output muted ${muted ? 'true' : 'false'}`)
}

async function readLinux () {
  const [{ stdout: vol }, { stdout: mute }] = await Promise.all([
    run('pactl', ['get-sink-volume', '@DEFAULT_SINK@'], { timeout: TIMEOUT_MS }),
    run('pactl', ['get-sink-mute', '@DEFAULT_SINK@'], { timeout: TIMEOUT_MS }),
  ])
  const percent = Number(/(\d+)%/u.exec(String(vol))?.[1])
  const muted = /yes/u.test(String(mute))
  if (!Number.isFinite(percent)) throw new Error('unparsable pactl output')
  return { volume: percent, muted }
}

async function writeLinux ({ volume, muted }) {
  if (typeof volume === 'number') {
    await run('pactl', ['set-sink-volume', '@DEFAULT_SINK@', `${clampVolume(volume)}%`], { timeout: TIMEOUT_MS })
  }
  if (typeof muted === 'boolean') {
    await run('pactl', ['set-sink-mute', '@DEFAULT_SINK@', muted ? '1' : '0'], { timeout: TIMEOUT_MS })
  }
}

async function systemState () {
  try {
    if (process.platform === 'darwin') {
      return { ok: true, supported: true, platform: 'darwin', ...(await readMac()) }
    }
    if (process.platform === 'linux') {
      return { ok: true, supported: true, platform: 'linux', ...(await readLinux()) }
    }
    return {
      ok: true,
      supported: false,
      platform: process.platform,
      reason: 'system volume is only wired up for macOS and Linux',
    }
  } catch (error) {
    return {
      ok: true,
      supported: false,
      platform: process.platform,
      reason: String(error && error.message ? error.message : error).slice(0, 300),
    }
  }
}

async function setSystem ({ volume, muted }) {
  const wantVolume = typeof volume === 'number' && Number.isFinite(volume) ? clampVolume(volume) : undefined
  const wantMuted = typeof muted === 'boolean' ? muted : undefined
  if (process.platform === 'darwin') await writeMac({ volume: wantVolume, muted: wantMuted })
  else if (process.platform === 'linux') await writeLinux({ volume: wantVolume, muted: wantMuted })
  else throw new Error('system volume is only wired up for macOS and Linux')
}

export function apply (ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-volume-knob/system',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, await systemState())
        return
      }
      if (req.method !== 'POST' && req.method !== 'PUT') {
        sendJson(res, 405, { ok: false, error: { code: 'method', message: 'GET or POST' } })
        return
      }
      if (!isTrusted(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: `${NS}: same-origin only` } })
        return
      }
      let payload = {}
      try {
        const raw = await readBody(req)
        payload = raw ? JSON.parse(raw) : {}
      } catch (error) {
        sendJson(res, 400, { ok: false, error: { code: 'body', message: String(error && error.message ? error.message : error) } })
        return
      }
      try {
        await setSystem({
          volume: typeof payload.volume === 'number' ? payload.volume : undefined,
          muted: typeof payload.muted === 'boolean' ? payload.muted : undefined,
        })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: { code: 'set', message: String(error && error.message ? error.message : error) } })
        return
      }
      sendJson(res, 200, await systemState())
    },
  }), `${NS}: system volume route`)

  // Diagnostics: the browser half reports what it saw (selector hits, synth
  // result, playback, errors) so the host log can answer "why did nothing
  // happen" without a dev console.
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/dsh-volume-knob/diag',
    handler: async (req, res) => {
      if (req.method === 'GET') {
        sendJson(res, 200, { ok: true, entries: diagnostics })
        return
      }
      if (req.method !== 'POST') {
        sendJson(res, 405, { ok: false, error: { code: 'method', message: 'GET or POST' } })
        return
      }
      if (!isTrusted(req)) {
        sendJson(res, 403, { ok: false, error: { code: 'forbidden', message: `${NS}: same-origin only` } })
        return
      }
      try {
        const raw = await readBody(req)
        const payload = raw ? JSON.parse(raw) : {}
        record(payload)
        sendJson(res, 200, { ok: true })
      } catch (error) {
        sendJson(res, 400, { ok: false, error: { code: 'body', message: String(error && error.message ? error.message : error) } })
      }
    },
  }), `${NS}: diagnostics route`)
}
