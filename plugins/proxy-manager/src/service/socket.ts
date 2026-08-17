// eslint-disable-next-line -- see below: the un-prefixed specifier is the point
import type { Socket } from 'net'

/**
 * The socket type this pack passes between its own modules — and the one place
 * a genuinely surprising fact about this workspace's types is written down.
 *
 * **`net` and `node:net` are two different types here, and only one of them is
 * assignable to the other.** *(measured, 2026-08-17, TypeScript 7 with
 * `types: ["bun"]`)*:
 *
 * ```ts
 * import type { Socket as A } from 'node:net'
 * import type { Socket as B } from 'net'
 * const ok = (a: A): B => a    // fine — A is a superset
 * const no = (b: B): A => b    // error: B is missing getTypeOfService, setTypeOfService
 * ```
 *
 * `socks`'s own typings declare `SocksClientEstablishedEvent.socket` as the
 * **`net`** flavour, because the package's `devDependencies` pin
 * `@types/node@^20`; our `node:net` resolves to the newer set that
 * `@types/bun` brings. Typing our interfaces against `node:net` therefore
 * makes `return info.socket` a type error, and the only ways out are an
 * `as`-cast (forbidden — 00-overview §4) or this.
 *
 * So every interface in this directory is typed against the **narrower**
 * flavour, which both satisfy: a `node:net` socket from our own
 * `net.createServer` and a `socks` socket are each assignable to it. Nothing
 * is imported at run time — this file is types only, and Bun resolves both
 * specifiers to the same builtin anyway.
 */
export type BridgeSocket = Socket

/**
 * `net.Server` has **no event methods** in this workspace's types, and that is
 * a bug in `@types/node`, not in this code.
 *
 * *(measured, 2026-08-17, against `@types/node@26.1.2`, and reproduced
 * identically under TypeScript **7.0.2** and TypeScript **5.9.3** — so it is
 * not a `tsgo` regression.)*
 *
 * ```ts
 * const server = net.createServer(() => {})
 * server.on('error', () => {})   // error TS2339: Property 'on' does not exist on type 'Server'
 * ```
 *
 * The cause: `net.d.ts` declares `class Server implements EventEmitter` — and
 * `implements` adds nothing — then merges the methods in with
 * `interface Server extends InternalEventEmitter<ServerEventMap> {}`, whose
 * base it imports as `import { … InternalEventEmitter … } from "node:events"`.
 * `InternalEventEmitter` is not exported from that module: it lives inside
 * `global { namespace NodeJS { … } }`. So the base is unresolved, the merge
 * contributes nothing, and `skipLibCheck` (which this workspace sets, and
 * needs) hides the error that would have said so. `net.Socket` is unaffected,
 * because `Socket` is three inheritance levels from `EventEmitter` and
 * `@types/node` therefore copies the method signatures into it by hand.
 *
 * The augmentation below adds back only the three signatures this pack uses,
 * for the one event it listens for. It is a **type-level** statement about
 * methods that exist at run time on every Node build — not an `as`-cast, and
 * not a claim about behaviour. It disappears the day `@types/node` fixes the
 * import, at which cost of nothing: an interface that re-declares a member
 * with a compatible signature is a legal merge, not a conflict.
 */
declare module 'node:net' {
  interface Server {
    on(event: 'error', listener: (err: Error) => void): this
    once(event: 'error', listener: (err: Error) => void): this
    removeListener(event: 'error', listener: (err: Error) => void): this
  }
}
