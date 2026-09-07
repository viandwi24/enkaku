import { Hono } from 'hono'
import {
  AndroidSdkStatusResponseSchema,
  SdkInstallBodySchema,
  SdkInstallResponseSchema,
  VmCreateBodySchema,
  VmListResponseSchema,
  VmResponseSchema,
  VmSpecSchema,
  type VmCreateBody,
  type VmRecord,
  type VmSpec,
} from '@enkaku/protocol'
import { can } from '../auth/acl'
import type { AuthEnv } from '../auth/middleware'
import { EnkakuError } from '../util/errors'
import type { VmManager } from '../vm/manager'
import { deriveAbi } from '../vm/provider-avd'
import { appendInstallLine, installSdkPackages, readSdkInventory, type SdkInventory } from '../vm/sdk-install'
import type { Logger } from '../util/logger'
import type { VmRecord as CoreVmRecord } from '../vm/types'
import { typedJson } from './typed-json'

const ERROR_STATUS: Record<string, number> = {
  'auth.forbidden': 403,
  E_BAD_REQUEST: 400,
  E_VM_NOT_FOUND: 404,
  E_VM_LIMIT: 409,
  E_VM_NAME_TAKEN: 409,
  E_VM_NO_PORT: 409,
  E_VM_CONFLICT: 409,
  E_ANDROID_SDK_MISSING: 503,
}

/** Wire-shape a core `VmRecord` — `Date` fields become integer unix seconds (`CLAUDE.md`). */
function toWire(record: CoreVmRecord): VmRecord {
  return {
    id: record.id,
    name: record.name,
    state: record.state,
    consolePort: record.consolePort,
    serial: record.serial,
    spec: record.spec,
    message: record.message,
    createdAt: Math.floor(record.createdAt.getTime() / 1000),
    startedAt: record.startedAt ? Math.floor(record.startedAt.getTime() / 1000) : null,
  }
}

/**
 * `/api/vms` (plan 402 §4.2) — five routes over plan 401's `VmManager`. No
 * WebSocket message (plan 402 §3.2): Studio polls this while its dialog is
 * open, and once the emulator boots the ordinary `device.*` events take over
 * (plan 400 D2).
 *
 * A VM is not a device (plan 400 D6, plan 402 §3.4): this file never joins,
 * embeds, or looks up a `devices` row. The `serial` field is observational
 * only.
 */
/**
 * Fill in the parts of a spec the operator did not choose, from what the host
 * actually has — and refuse early, by name, when what they DID choose is not
 * installed.
 *
 * Both halves exist because of the same failure: creating a virtual device on
 * a host whose only system image was android-35 died with `avdmanager`'s own
 * "Package path is not valid", after the button was pressed, quoting a list
 * of valid paths in raw tool output (owner, 2026-09-07). The api level came
 * from a schema default of 36 that had never looked at the machine.
 *
 * This is the same shape as the JDK fix: find what the host has before
 * running the tool, rather than translating the tool's complaint afterwards.
 */
export async function resolveSpec(body: VmCreateBody, sdk: { systemImages: string[] }): Promise<VmSpec> {
  const abi = body.abi ?? deriveAbi()
  const variant = body.variant
  const imageFor = (apiLevel: number) => `system-images;android-${apiLevel};${variant};${abi}`

  // Newest first, so an unspecified api level gets the most recent image the
  // host can actually boot rather than the oldest one lying around.
  const installed = sdk.systemImages
    .map((image) => {
      const match = /^system-images;android-(\d+);([^;]+);(.+)$/.exec(image)
      return match ? { apiLevel: Number(match[1]), variant: match[2], abi: match[3] } : null
    })
    .filter((x): x is { apiLevel: number; variant: string; abi: string } => x !== null)
    .filter((x) => x.variant === variant && x.abi === abi)
    .sort((a, b) => b.apiLevel - a.apiLevel)

  if (body.apiLevel === undefined) {
    const newest = installed[0]?.apiLevel
    if (newest === undefined) {
      throw new EnkakuError(
        'E_ANDROID_SDK_MISSING',
        `no system image is installed for ${variant} on ${abi}. Install one from the SDK section of this page, or pick a variant you already have: ${sdk.systemImages.join(', ') || 'none at all'}`,
      )
    }
    return VmSpecSchema.parse({ ...body, apiLevel: newest, abi })
  }

  if (!sdk.systemImages.includes(imageFor(body.apiLevel))) {
    throw new EnkakuError(
      'E_ANDROID_SDK_MISSING',
      `${imageFor(body.apiLevel)} is not installed. Installed: ${sdk.systemImages.join(', ') || 'none at all'}`,
    )
  }
  return VmSpecSchema.parse({ ...body, abi })
}

/**
 * What `createVmRoutes` needs. `readSdkInventory` is the only optional-for-
 * production entry: it exists so a ROUTE test can say what the host has
 * without the host having to have it.
 *
 * Without it these routes were untestable anywhere an Android SDK is not
 * installed, which includes every CI runner this repo uses. `POST /` reads
 * the real inventory before it reaches the manager, so on a bare machine
 * `resolveSpec` threw `E_ANDROID_SDK_MISSING` and every create-shaped test
 * got a 503 no matter what it was actually asserting — including the ACL and
 * error-mapping tests, which never meant to touch the SDK at all. The fake
 * `VmManager` those tests already build could not help: the throw happens
 * before `manager.create` is called.
 */
export interface VmRoutesDeps {
  manager: VmManager
  dataDir: string
  log: Logger
  toolchainSdkmanager?: () => Promise<string | null>
  installCmdlineTools?: () => Promise<void>
  /** Injectable for tests; production leaves it unset and the real host read is used. */
  readSdkInventory?: () => Promise<SdkInventory>
}

export function createVmRoutes(deps: VmRoutesDeps): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>()

  /** One accessor for the three places that need the inventory, so a test substitutes it once. */
  const sdkInventory = (): Promise<SdkInventory> => deps.readSdkInventory?.() ?? readSdkInventory(deps.dataDir, deps.toolchainSdkmanager)

  function authorizeView(user: { role: 'admin' | 'operator' } | undefined): void {
    if (!user || !can(user.role, 'vm.view')) {
      throw new EnkakuError('auth.forbidden', 'requires the vm.view permission')
    }
  }

  /**
   * Creating, starting, stopping or deleting a virtual device now needs
   * `vm.manage`, which is admin-only.
   *
   * It used to need `device.enroll`, on the reading that adding a virtual
   * device is adding a device (plan 402 §3.3) — and this function's own
   * comment recorded the doubt: "whether this should instead be admin-only
   * is plan 402 §9 Q4 — an owner decision". The owner took it on 2026-09-05.
   *
   * The reading was too generous. Operators hold `device.enroll`, so
   * DELETING a host VM was as easy as enrolling a phone — while installing a
   * single toolchain tool needed `tool.manage`. But a VM is not a phone
   * someone plugged in: it is a process on the host, several gigabytes of
   * disk, and a claimed console port, created and destroyed by this farm.
   * That is the shape of `tool.manage`, and it is graded to match.
   */
  function authorizeManage(user: { role: 'admin' | 'operator' } | undefined): void {
    if (!user || !can(user.role, 'vm.manage')) {
      throw new EnkakuError('auth.forbidden', 'requires the vm.manage permission')
    }
  }

  /**
   * The SDK install log, in memory, keyed by the id the POST hands back.
   *
   * Not a job and not an operation: an SDK install belongs to the HOST, not
   * to a device, and every existing progress surface in this codebase is
   * device-scoped. Memory is honest about what it is — a core restart loses
   * the log, and the install itself was a child process that died with it.
   * Bounded, because `sdkmanager` on a slow line can print for minutes.
   */
  const installs = new Map<string, { lines: string[]; done: boolean; error: string | null }>()
  const MAX_LINES = 500

  /**
   * Install the Android SDK command-line tools through the Toolchain Manager
   * — the ONE package Enkaku fetches itself, sha256-pinned from Google's own
   * repository, exactly as adb is (`LICENSES.md`, revised 2026-09-06).
   *
   * Separate from `/sdk/install` because it is a different act with different
   * licensing: this one is Enkaku downloading, that one is the operator's
   * `sdkmanager` downloading. It is also the bootstrap — without it, a bare
   * host has nothing for `/sdk/install` to run.
   */
  app.post('/sdk/cmdline-tools', async (c) => {
    authorizeManage(c.get('user'))
    if (!deps.installCmdlineTools) throw new EnkakuError('E_NOT_SUPPORTED', 'this core has no toolchain manager wired')
    await deps.installCmdlineTools()
    return typedJson(c, AndroidSdkStatusResponseSchema, { sdk: await sdkInventory() })
  })

  app.get('/sdk', async (c) => {
    authorizeView(c.get('user'))
    return typedJson(c, AndroidSdkStatusResponseSchema, { sdk: await sdkInventory() })
  })

  app.get('/sdk/install/:id', (c) => {
    authorizeView(c.get('user'))
    const run = installs.get(c.req.param('id'))
    if (!run) throw new EnkakuError('E_NOT_FOUND', 'no such install')
    return c.json({ lines: run.lines, done: run.done, error: run.error })
  })

  /**
   * Install Android SDK packages using the host's OWN `sdkmanager`.
   *
   * Enkaku still never downloads the SDK — `vm/sdk.ts` states that rule and
   * the Android SDK Terms are why. What this adds is the button: the
   * operator's own tool, packages they picked from a closed list, a
   * destination the SERVER chooses between two, and licences they accepted
   * in the interface rather than on a prompt nobody can see.
   */
  app.post('/sdk/install', async (c) => {
    authorizeManage(c.get('user'))
    const body = SdkInstallBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', body.error.issues.map((i) => i.message).join('; '))

    const id = crypto.randomUUID()
    const run = { lines: [] as string[], done: false, error: null as string | null }
    installs.set(id, run)
    const push = (line: string) => {
      // Rewrites the progress bar in place rather than appending it — see
      // `appendInstallLine`. Without that, one system image is thousands of
      // redraws and MAX_LINES throws away everything that mattered.
      appendInstallLine(run.lines, line)
      if (run.lines.length > MAX_LINES) run.lines.splice(0, run.lines.length - MAX_LINES)
    }
    // Answered immediately: a system image is gigabytes, and a request that
    // waits for it is a request that times out somewhere in between.
    void installSdkPackages(body.data, { dataDir: deps.dataDir, log: deps.log, ...(deps.toolchainSdkmanager ? { toolchainSdkmanager: deps.toolchainSdkmanager } : {}) }, push)
      .then((r) => push(`done — ${r.packages.length} package(s) into ${r.root}`))
      .catch((err) => {
        run.error = err instanceof Error ? err.message : String(err)
        push(run.error)
      })
      .finally(() => {
        run.done = true
      })
    return typedJson(c, SdkInstallResponseSchema, { operationId: id }, 202)
  })

  app.get('/', (c) => {
    authorizeView(c.get('user'))
    return typedJson(c, VmListResponseSchema, { vms: deps.manager.list().map(toWire) })
  })

  app.post('/', async (c) => {
    authorizeManage(c.get('user'))
    const body = VmCreateBodySchema.safeParse(await c.req.json().catch(() => null))
    if (!body.success) throw new EnkakuError('E_BAD_REQUEST', 'a valid virtual device spec is required')
    const record = await deps.manager.create(await resolveSpec(body.data, await sdkInventory()))
    return typedJson(c, VmResponseSchema, { vm: toWire(record) }, 201)
  })

  app.post('/:id/start', (c) => {
    authorizeManage(c.get('user'))
    const id = c.req.param('id')
    // The row must exist before anything is kicked off, so a bad id is a
    // synchronous 404 rather than a background failure nobody is polling
    // for yet.
    const before = deps.manager.list().find((v) => v.id === id)
    if (!before) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)

    // `VmManager.start` awaits the FULL boot-poll loop (up to
    // `VM_BOOT_TIMEOUT_SEC`, plan 401 §4.4/§11) — up to five minutes, which
    // no reverse proxy or browser will tolerate on one HTTP request. This
    // route does NOT await it: calling an async function runs it
    // synchronously up to its first `await` before returning a pending
    // promise, and `VmManager.start`'s own first line sets the row to
    // `starting` before its first `await` (`manager.ts`'s `setRow(id, {
    // state: 'starting', ... })` precedes `await deps.provider.start(...)`).
    // So by the time this line returns, the row is already `starting`, and
    // the response below reads that state straight back off the manager.
    // The background promise is left running; its terminal state (`running`
    // or `failed`) lands in the row and Studio's dialog polls `GET /api/vms`
    // for it (plan 402 §3.2) rather than this request waiting for it.
    const startPromise = deps.manager.start(id)
    // Already recorded on the row by `VmManager` itself (`failed` +
    // message) — this catch exists only so a later provider/adb failure
    // never surfaces as an unhandled rejection.
    startPromise.catch(() => {})

    const after = deps.manager.list().find((v) => v.id === id)
    if (!after) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
    return typedJson(c, VmResponseSchema, { vm: toWire(after) }, 202)
  })

  app.post('/:id/stop', (c) => {
    authorizeManage(c.get('user'))
    const id = c.req.param('id')
    const before = deps.manager.list().find((v) => v.id === id)
    if (!before) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)

    // Same fire-and-forget shape as `/start` above, for the same reason:
    // `VmManager.stop` sets the row to `stopping` before its own first
    // `await` (`stopImpl`'s `setRow(id, { state: 'stopping' })` precedes
    // `await deps.provider.stop(...)`), so the synchronous prefix has
    // already run by the time this line returns, and the 202 response
    // below reads `stopping` straight back off the manager rather than
    // waiting out the stop grace period.
    const stopPromise = deps.manager.stop(id)
    // Swallowed for the same reason as `/start`'s catch above.
    stopPromise.catch(() => {})

    const after = deps.manager.list().find((v) => v.id === id)
    if (!after) throw new EnkakuError('E_VM_NOT_FOUND', `no virtual device with id ${id}`)
    return typedJson(c, VmResponseSchema, { vm: toWire(after) }, 202)
  })

  app.delete('/:id', async (c) => {
    authorizeManage(c.get('user'))
    const id = c.req.param('id')
    // Stops first if running, then deletes the AVD (plan 402 §4.2). This
    // never touches the device row (plan 400 D6) — `VmManager.remove` only
    // ever reaches into `virtual_devices`.
    await deps.manager.remove(id)
    return c.body(null, 204)
  })

  app.onError((err, c) => {
    if (err instanceof EnkakuError) return c.json(err.toJSON(), (ERROR_STATUS[err.code] ?? 500) as 400)
    throw err
  })

  return app
}
