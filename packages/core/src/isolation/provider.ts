import type { Subprocess } from 'bun'

/**
 * Isolasi eksekusi job (plan 11 §4.5, spec §11.3).
 *
 * Mode local single-tenant memakai `child-process`: yang dijanjikan hanya
 * **crash containment** — script tidak bisa menjatuhkan core dan timeout
 * selalu membebaskan device. Itu BUKAN security boundary.
 *
 * Multi-tenant cloud butuh batas sungguhan. Matriks pilihan:
 *
 * | Mode           | Startup | Kekuatan isolasi                    | Ops        |
 * |----------------|---------|-------------------------------------|------------|
 * | child-process  | ~10 ms  | ❌ crash containment saja           | nol        |
 * | container      | 0,5–2 s | ✅ namespace fs/net/pid, caps drop  | menengah   |
 * | gVisor         | +ratusan ms | ✅✅ syscall interception       | menengah   |
 * | microVM        | ~125 ms + rootfs | ✅✅✅ batas hardware       | tinggi     |
 *
 * gVisor cukup mengganti `--runtime=runsc` pada mode container, jadi desain
 * ini tidak menghalangi tahap berikutnya.
 */
export type IsolationMode = 'child-process' | 'container'

export interface SpawnRequest {
  /** Path entry runner (child-entry.ts). */
  entryPath: string
  /** Path bundle script yang akan di-import child. */
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

/** Default: child process biasa — dipakai mode local single-tenant. */
export function createChildProcessIsolation(): IsolationProvider {
  return {
    mode: 'child-process',
    available: true,
    spawn(req, ipc) {
      return Bun.spawn([process.execPath, req.entryPath, req.bundlePath], {
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
  /** `docker` atau `podman`. */
  runtime: string
  image: string
  /** `runsc` untuk gVisor; kosong = runtime default. */
  ociRuntime?: string
  /** Batas resource per job. */
  memoryMb?: number
  cpus?: number
  /** Direktori host yang di-mount read-only (bundle & runner entry). */
  mounts?: Array<{ hostPath: string; containerPath: string }>
}

/**
 * Isolasi container per job. IPC lewat stdio (bukan Bun `ipc`), karena
 * container tidak berbagi file descriptor IPC dengan parent — child-entry
 * memakai transport yang sama bentuknya, hanya berpindah kanal.
 *
 * Catatan penting: job yang butuh device tetap berkomunikasi lewat parent
 * (device call via IPC), jadi container TIDAK perlu akses adb maupun USB.
 * Itu justru yang membuat isolasi ini masuk akal.
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
        '--network=none', // script tidak butuh network sendiri; device diakses lewat parent
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
      // IPC via stdout JSON-lines: child-entry mengirim message di stdout
      // ketika `process.send` tidak tersedia (mode container).
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
          // baris bukan message IPC (mis. console.log biasa) — abaikan
        }
      }
    }
  } catch {
    // stream tertutup saat container berhenti
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
