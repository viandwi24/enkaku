#!/usr/bin/env bun
/**
 * Bring-up CLI for the on-device guest agent — the reproducible form of plan 44 §5.1.
 *
 * This is a TEMPORARY developer tool, not the product. The product path is Studio driving the
 * `vpn-helper` engine, which does not exist yet (plan 44 steps 5.3–5.9). Delete this once it does.
 *
 *   bun scripts/guest-agent.ts install
 *   bun scripts/guest-agent.ts route socks5://user:pass@host:1337
 *   bun scripts/guest-agent.ts status
 *   bun scripts/guest-agent.ts stop
 *   bun scripts/guest-agent.ts uninstall
 *
 * Add --serial <S> to target one of several devices, and --port <N> to move the forwarded host
 * port (default 27400, deliberately outside the 27100–27299 ui-server range).
 */

const PKG = 'dev.enkaku.guestagent'
const SOCKET = 'enkaku-guest-agent'
const APK = 'apps/guest-agent/app/build/outputs/apk/debug/app-debug.apk'
const ADB = `${process.env.HOME}/Library/Android/sdk/platform-tools/adb`

const args = process.argv.slice(2)
const cmd = args[0]
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? undefined : args[i + 1]
}
const serial = flag('serial')
const port = Number(flag('port') ?? 27400)
// Regenerated per bring-up: the agent holds it in memory only, so a stale one is never usable.
const token = `bringup-${Date.now()}`

async function adb(...a: string[]): Promise<string> {
  const argv = serial ? [ADB, '-s', serial, ...a] : [ADB, ...a]
  const proc = Bun.spawn(argv, { stdout: 'pipe', stderr: 'pipe' })
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const code = await proc.exited
  if (code !== 0 && !err.includes('not found')) {
    throw new Error(`adb ${a.join(' ')} failed (${code}): ${err.trim() || out.trim()}`)
  }
  return (out + err).trim()
}

/** One request, one response, over the forwarded control socket. */
async function call(method: string, extra: Record<string, unknown> = {}): Promise<any> {
  return new Promise(async (resolve, reject) => {
    const chunks: string[] = []
    const timer = setTimeout(() => reject(new Error(`${method} timed out — is the agent running?`)), 15_000)
    const sock = await Bun.connect({
      hostname: '127.0.0.1',
      port,
      socket: {
        data(s, d) {
          chunks.push(d.toString())
          const joined = chunks.join('')
          if (!joined.includes('\n')) return
          clearTimeout(timer)
          s.end()
          try {
            resolve(JSON.parse(joined.split('\n')[0]!))
          } catch (e) {
            reject(e)
          }
        },
        error(_s, e) {
          clearTimeout(timer)
          reject(e)
        },
      },
    })
    sock.write(`${JSON.stringify({ id: '1', method, token: readToken(), ...extra })}\n`)
  })
}

/** The token from the last `install` run, so `route`/`status`/`stop` can be separate invocations. */
const TOKEN_FILE = '.dev-data/.guest-agent-token'
function readToken(): string {
  try {
    return require('node:fs').readFileSync(TOKEN_FILE, 'utf8').trim()
  } catch {
    return token
  }
}
async function writeToken(value: string) {
  await Bun.write(TOKEN_FILE, value)
}

function parseProxy(url: string) {
  const u = new URL(url)
  if (u.protocol !== 'socks5:') throw new Error(`expected a socks5:// URL, got ${u.protocol}`)
  if (!u.hostname || !u.port) throw new Error('the URL needs a host and a port')
  return {
    host: u.hostname,
    port: Number(u.port),
    username: decodeURIComponent(u.username) || undefined,
    password: decodeURIComponent(u.password) || undefined,
    udpMode: 'udp' as const,
  }
}

async function install() {
  console.log('→ installing…')
  console.log(' ', await adb('install', '-r', '-g', APK))

  console.log('→ pre-granting VPN consent (this is what suppresses the consent dialog)')
  await adb('shell', 'appops', 'set', PKG, 'ACTIVATE_VPN', 'allow')
  const op = await adb('shell', 'appops', 'get', PKG, 'ACTIVATE_VPN')
  if (!op.includes('allow')) {
    // @hide behaviour; if a future Android drops it, failing loudly beats a mysterious null later.
    throw new Error(`ACTIVATE_VPN was not granted (got "${op}") — the app-op route may have changed`)
  }
  console.log(' ', op)

  console.log('→ bootstrapping (clears the stopped state, hands over the token)')
  await adb('shell', 'am', 'start', '-n', `${PKG}/.BootstrapActivity`, '--es', 'token', token)
  await writeToken(token)
  await Bun.sleep(1500)

  console.log('→ forwarding the control socket')
  await adb('forward', `tcp:${port}`, `localabstract:${SOCKET}`)
  const list = await adb('forward', '--list')
  const owner = list.split('\n').map((l) => l.trim().split(/\s+/)).find(([, local]) => local === `tcp:${port}`)
  if (!owner) throw new Error(`tcp:${port} is not forwarded`)
  if (serial && owner[0] !== serial) {
    throw new Error(`tcp:${port} belongs to ${owner[0]}, not ${serial} — refusing to drive another device`)
  }
  console.log(' ', owner.join(' '))

  // The agent binds its socket a moment after the process starts, and a cold start after a
  // force-stop is slower than a warm one. Retry rather than assume a fixed sleep was enough —
  // guessing here is what produced a spurious "is the agent running?" during bring-up.
  let hello: any
  for (let attempt = 1; attempt <= 8; attempt++) {
    try {
      hello = await call('hello')
      break
    } catch (e) {
      if (attempt === 8) throw e
      await Bun.sleep(500)
    }
  }
  console.log('→ handshake:', JSON.stringify(hello.result ?? hello))
}

async function route(url: string) {
  const cfg = parseProxy(url)
  console.log(`→ starting route via ${cfg.host}:${cfg.port}${cfg.username ? ' (authenticated)' : ''}`)
  const started = await call('route.start', { config: cfg })
  if (!started.ok) throw new Error(`route.start failed: ${started.error?.code} ${started.error?.message}`)
  await Bun.sleep(3000)
  await status()
}

async function status() {
  const s = await call('route.status')
  console.log('→ status:', JSON.stringify(s.result ?? s))
  const vpn = await adb('shell', 'dumpsys', 'connectivity')
  const line = vpn.split('\n').find((l) => l.includes(`VPN:${PKG}`))
  console.log('→ android:', line ? line.trim().slice(0, 160) : 'no VPN network registered')
}

async function main() {
  switch (cmd) {
    case 'install':
      await install()
      break
    case 'route': {
      const url = args[1]
      if (!url) throw new Error('usage: route socks5://user:pass@host:port')
      await route(url)
      break
    }
    case 'status':
      await status()
      break
    case 'stop': {
      console.log('→ stopping:', JSON.stringify((await call('route.stop')).result))
      // `route.stop` acknowledges the request, not completion — teardown joins the tunnel thread
      // with a timeout, so a status read immediately after can still see the old state. Poll until
      // the device agrees rather than reporting the race as the answer.
      for (let i = 0; i < 10; i++) {
        await Bun.sleep(500)
        if ((await call('route.status')).result?.up === false) break
      }
      await status()
      break
    }
    case 'uninstall':
      await adb('forward', '--remove', `tcp:${port}`).catch(() => undefined)
      console.log(await adb('uninstall', PKG))
      break
    default:
      console.log(`usage: bun scripts/guest-agent.ts <install|route <url>|status|stop|uninstall> [--serial S] [--port N]`)
      process.exit(1)
  }
}

main().catch((e) => {
  console.error('✗', e.message)
  process.exit(1)
})
