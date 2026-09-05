import type { AndroidSdk } from './sdk'
import type { VmHandle, VmProvider, VmSpec } from './types'
import { EnkakuError } from '../util/errors'

/**
 * The one `VmProvider` implementation (plan 400 D7) — the Android Emulator,
 * driven through the deprecated-but-still-working `avdmanager` and
 * `emulator` binaries (plan 400 D4). This subsystem's job ends when the
 * emulator process is spawned/booted; discovery and admission are the
 * existing reconciler's job, and nothing here reaches for it or for the
 * adb server directly (plan 400 D2, plan 401 §3.1).
 */

/** Apple Silicon needs arm64-v8a; Intel Macs and Linux x64 need x86_64 (plan 400 R3). Derived, never asked, with an operator override via `spec.abi`. */
export function deriveAbi(arch: NodeJS.Architecture = process.arch): 'arm64-v8a' | 'x86_64' {
  return arch === 'arm64' ? 'arm64-v8a' : 'x86_64'
}

/** How much of a failed start's stderr is kept for the `failed` row's message — an emulator that refuses to start says why there and nowhere else. */
const STDERR_TAIL_BYTES = 4096

export interface VmProviderAvdDeps {
  sdk: AndroidSdk
  /** Injectable so tests can prove the argv without spawning a process — mirrors `adb-server-control.ts`'s `spawnAdb` seam. Defaults to a real `Bun.spawn`. */
  spawn?: (binary: string, args: string[], opts: { stdin?: 'pipe'; stdout?: 'pipe' | 'ignore'; stderr?: 'pipe' | 'ignore' }) => Bun.Subprocess<'pipe' | 'ignore', 'pipe' | 'ignore', 'pipe' | 'ignore'>
}

function readTail(chunks: Uint8Array[], maxBytes: number): string {
  const total = Buffer.concat(chunks)
  const tail = total.subarray(Math.max(0, total.length - maxBytes))
  return tail.toString('utf8')
}

export function createAvdProvider(deps: VmProviderAvdDeps): VmProvider {
  const spawn = deps.spawn ?? ((binary, args, opts) => Bun.spawn([binary, ...args], opts))

  return {
    async create(spec: VmSpec): Promise<void> {
      const abi = spec.abi ?? deriveAbi()
      const sysImage = `system-images;android-${spec.apiLevel};${spec.variant};${abi}`
      // Do NOT pass `-f`: overwriting an operator's existing AVD is destructive, and
      // an existing AVD of this name is an error (`VmProvider.create`'s own contract).
      const proc = spawn(
        deps.sdk.avdmanager,
        ['create', 'avd', '-n', spec.name, '-k', sysImage, '-d', spec.deviceProfile],
        { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' },
      )
      // avdmanager asks "Do you wish to create a custom hardware profile [no]" —
      // feed `no` on stdin so the process can never hang waiting for a TTY.
      const stdin = proc.stdin as Bun.FileSink
      stdin.write('no\n')
      await stdin.end()
      const [exitCode, stderrChunks] = await Promise.all([proc.exited, collect(proc.stderr)])
      if (exitCode !== 0) {
        throw new EnkakuError('E_VM_CREATE_FAILED', `avdmanager create avd failed (exit ${exitCode}): ${readTail(stderrChunks, STDERR_TAIL_BYTES)}`)
      }
    },

    async start(spec: VmSpec, consolePort: number): Promise<VmHandle> {
      const proc = spawn(
        deps.sdk.emulator,
        [
          `@${spec.name}`,
          '-no-window',
          '-no-audio',
          '-no-boot-anim',
          '-no-snapshot',
          '-port',
          String(consolePort),
          '-memory',
          String(spec.memoryMb),
        ],
        { stdout: 'pipe', stderr: 'pipe' },
      )
      return {
        consolePort,
        kill: (signal?: NodeJS.Signals) => proc.kill(signal),
        exited: proc.exited,
      }
    },

    async stop(handle: VmHandle, graceMs: number): Promise<void> {
      handle.kill('SIGTERM')
      const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), graceMs))
      const outcome = await Promise.race([handle.exited.then(() => 'exited' as const), timeout])
      if (outcome === 'timeout') {
        handle.kill('SIGKILL')
        await handle.exited
      }
    },

    async destroy(spec: VmSpec): Promise<void> {
      const proc = spawn(deps.sdk.avdmanager, ['delete', 'avd', '-n', spec.name], { stdout: 'pipe', stderr: 'pipe' })
      const [exitCode, stderrChunks] = await Promise.all([proc.exited, collect(proc.stderr)])
      if (exitCode !== 0) {
        throw new EnkakuError('E_VM_DESTROY_FAILED', `avdmanager delete avd failed (exit ${exitCode}): ${readTail(stderrChunks, STDERR_TAIL_BYTES)}`)
      }
    },
  }
}

async function collect(stream: ReadableStream<Uint8Array> | undefined): Promise<Uint8Array[]> {
  if (!stream) return []
  const chunks: Uint8Array[] = []
  for await (const chunk of stream) {
    chunks.push(chunk)
  }
  return chunks
}
