import { EnkakuError } from '../util/errors'

/** Plan 400 R8: the emulator accepts 5554-5682; console ports are even. */
export const VM_PORT_MIN = 5554
export const VM_PORT_MAX = 5682

/**
 * The next free even console port, skipping any port that answers a TCP connect.
 *
 * Probing matters: the farm does not own this range (plan 400 K2). The operator's own
 * Android Studio emulator very likely holds 5554 already, and claiming it would produce
 * a VM that never appears.
 */
export async function nextFreeConsolePort(opts: {
  taken: ReadonlySet<number>
  probe: (port: number) => Promise<boolean>
}): Promise<number> {
  for (let port = VM_PORT_MIN; port <= VM_PORT_MAX; port += 2) {
    if (opts.taken.has(port)) continue
    const busy = await opts.probe(port)
    if (!busy) return port
  }
  throw new EnkakuError('E_VM_NO_PORT', `no free console port in ${VM_PORT_MIN}-${VM_PORT_MAX} (every even port is taken or busy)`)
}
