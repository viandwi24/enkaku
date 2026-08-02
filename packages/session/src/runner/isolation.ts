import type { Subprocess } from 'bun'

/**
 * Isolasi eksekusi job (plan 11 §4.5, spec §11.3).
 *
 * Local single-tenant mode uses `child-process`: the only promise is **crash
 * containment** — a script cannot take the core down, and a timeout
 * always frees the device. That is NOT a security boundary.
 *
 * Multi-tenant cloud needs real boundaries. The options:
 *
 * | Mode           | Startup | Kekuatan isolasi                    | Ops        |
 * |----------------|---------|-------------------------------------|------------|
 * | child-process  | ~10 ms  | ❌ crash containment saja           | nol        |
 * | container      | 0,5–2 s | ✅ namespace fs/net/pid, caps drop  | menengah   |
 * | gVisor         | +ratusan ms | ✅✅ syscall interception       | menengah   |
 * | microVM        | ~125 ms + rootfs | ✅✅✅ batas hardware       | tinggi     |
 *
 * gVisor is just `--runtime=runsc` on the container mode, so this design does
 * not block that next step.
 */
export type IsolationMode = 'child-process' | 'container'

export interface SpawnRequest {
  /** Path entry runner (child-entry.ts). */
  entryPath: string
  /** Path to the script bundle the child will import. */
  bundlePath: string
  jobId: string
  env: Record<string, string>
}

export interface IsolationProvider {
  readonly mode: IsolationMode
  readonly available: boolean
  readonly reason?: string
  spawn(req: SpawnRequest, ipc: (raw: unknown) => void): Subprocess<'ignore', 'pipe', 'pipe'>
}

/**
 * True when running inside a `bun build --compile` executable. In that case the
 * embedded modules live on a virtual filesystem (`/$bunfs/` on POSIX, `~BUN` on
 * Windows) and `process.execPath` is the compiled binary itself.
 */
export function isCompiledBinary(): boolean {
  return Bun.main.includes('$bunfs') || Bun.main.includes('~BUN')
}

/** Default: an ordinary child process — used by local single-tenant mode. */
export function createChildProcessIsolation(): IsolationProvider {
  return {
    mode: 'child-process',
    available: true,
    spawn(req, ipc) {
      // Dev: `bun <child-entry.ts> <bundle>`. Compiled: the binary re-executes
      // itself with `--job-child` (child-entry.ts does not exist on disk there;
      // the core's entrypoint dispatches on the flag).
      const cmd = isCompiledBinary()
        ? [process.execPath, '--job-child', req.bundlePath]
        : [process.execPath, req.entryPath, req.bundlePath]
      return Bun.spawn(cmd, {
        ipc(raw) {
          ipc(raw)
        },
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, ...req.env },
      })
    },
  }
}

export interface ContainerIsolationOptions {
  /** `docker` or `podman`. */
  runtime: string
  image: string
  /** `runsc` for gVisor; empty means the default runtime. */
  ociRuntime?: string
  /** Batas resource per job. */
  memoryMb?: number
  cpus?: number
  /** Host directory mounted read-only (bundle and runner entry). */
  mounts?: Array<{ hostPath: string; containerPath: string }>
}

/**
 * Per-job container isolation. IPC runs over stdio rather than Bun's `ipc`,
 * because a container does not share the parent's IPC file descriptor —
 * child-entry uses the same transport shape, just a different channel.
 *
 * Worth noting: a job that needs a device still talks through the parent
 * (device calls over IPC), so the container needs NO adb and NO USB access.
 * That is exactly what makes this isolation practical.
 */
export function createContainerIsolation(opts: ContainerIsolationOptions): IsolationProvider {
  return {
    mode: 'container',
    available: true,
    spawn(req, ipc) {
      const args = [
        opts.runtime,
        'run',
        '--rm',
        '-i',
        '--network=none', // scripts need no network of their own; devices are reached via the parent
        '--cap-drop=ALL',
        '--security-opt=no-new-privileges',
        ...(opts.ociRuntime ? [`--runtime=${opts.ociRuntime}`] : []),
        ...(opts.memoryMb ? [`--memory=${opts.memoryMb}m`] : []),
        ...(opts.cpus ? [`--cpus=${opts.cpus}`] : []),
        ...(opts.mounts ?? []).flatMap((m) => ['-v', `${m.hostPath}:${m.containerPath}:ro`]),
        ...Object.entries(req.env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        opts.image,
        'bun',
        req.entryPath,
        req.bundlePath,
      ]
      const proc = Bun.spawn(args, { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' })
      // IPC over JSON-lines on stdout: child-entry writes its messages there
      // when `process.send` is unavailable (container mode).
      void readJsonLines(proc.stdout, ipc)
      return proc as unknown as Subprocess<'ignore', 'pipe', 'pipe'>
    },
  }
}

async function readJsonLines(stream: ReadableStream<Uint8Array> | undefined, onMessage: (v: unknown) => void) {
  if (!stream) return
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).trim()
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('{')) continue
        try {
          onMessage(JSON.parse(line))
        } catch {
          // not an IPC message (an ordinary console.log, say) — ignore it
        }
      }
    }
  } catch {
    // the stream closes when the container stops
  }
}

export function resolveIsolation(): IsolationProvider {
  const mode = process.env.ENKAKU_JOB_ISOLATION
  if (mode === 'container') {
    return createContainerIsolation({
      runtime: process.env.ENKAKU_CONTAINER_RUNTIME ?? 'docker',
      image: process.env.ENKAKU_JOB_IMAGE ?? 'oven/bun:1',
      ...(process.env.ENKAKU_OCI_RUNTIME ? { ociRuntime: process.env.ENKAKU_OCI_RUNTIME } : {}),
      memoryMb: Number.parseInt(process.env.ENKAKU_JOB_MEMORY_MB ?? '512', 10),
      cpus: Number.parseFloat(process.env.ENKAKU_JOB_CPUS ?? '1'),
    })
  }
  return createChildProcessIsolation()
}
