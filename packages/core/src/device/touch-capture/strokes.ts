import {
  ABS_MT_POSITION_X,
  ABS_MT_POSITION_Y,
  ABS_MT_PRESSURE,
  ABS_MT_SLOT,
  ABS_MT_TRACKING_ID,
  ABS_PRESSURE,
  ABS_X,
  ABS_Y,
  BTN_TOUCH,
  EV_ABS,
  EV_KEY,
  EV_SYN,
  SYN_REPORT,
  type EvdevEvent,
} from './evdev'
import type { TouchPanelProfile } from './probe'

/**
 * Contacts, reassembled from a flat evdev stream (plan 1000 §4.4) — pure and
 * synchronous, so the whole thing can be tested against a recorded
 * `getevent` transcript with no phone in the room.
 *
 * ## The frame rule
 *
 * evdev does not report positions; it reports CHANGES, and `SYN_REPORT`
 * closes a frame of them. A finger moving diagonally emits an X, then a Y,
 * then `SYN_REPORT` — three lines, ONE position. Sampling per line instead
 * of per frame doubles the sample count, halves every interval, and invents
 * an L-shaped path out of a straight one. So every sample this file emits is
 * taken at a `SYN_REPORT` and nowhere else.
 *
 * ## The two protocols
 *
 * - **Protocol B** (`mt-b`, every modern phone): contacts live in SLOTS.
 *   `ABS_MT_SLOT` selects the slot the following axes belong to,
 *   `ABS_MT_TRACKING_ID >= 0` opens a contact in it and `-1` lifts it. A
 *   driver sends `ABS_MT_SLOT` only when the slot CHANGES, so the current
 *   slot is sticky across frames — forgetting that attributes a second
 *   finger's whole path to the first.
 * - **Protocol A / single touch** (`mt-a`, `st`, old and unusual hardware):
 *   one contact, opened and closed by `BTN_TOUCH`, positioned by
 *   `ABS_X`/`ABS_Y` or `ABS_MT_POSITION_X/Y`. Additional fingers on a
 *   protocol-A panel are deliberately NOT reconstructed: doing it properly
 *   means tracking `SYN_MT_REPORT` groups and matching contacts between
 *   frames by proximity, which is guesswork this feature does not need. One
 *   finger is captured honestly; the rest are not invented.
 */

/** One position report at one `SYN_REPORT`, in the panel's own units. */
export interface RawSample {
  x: number
  y: number
  tsMs: number
  pressure: number | null
}

/** One contact, down to up, in the panel's own units — normalisation happens in `service.ts`, against the profile. */
export interface RawStroke {
  path: string
  pointerId: number
  samples: RawSample[]
  startTsMs: number
  endTsMs: number
  /** Another contact was down at some point during this one's life. */
  concurrent: boolean
  /** Samples the cap dropped out of the middle of the path. */
  droppedSamples: number
}

export interface StrokeAssemblerOpts {
  /** Resolves the panel a path belongs to; `null` means "not a touch device, ignore it". */
  profileFor: (path: string) => TouchPanelProfile | null
  /** Hard cap per stroke; the middle is thinned, both ends are kept (see `pushSample`). */
  maxSamples: number
  /** Only used when the stream carries no timestamps (`getevent` without `-t`), which this feature never does — the honest fallback rather than a zero. */
  now: () => number
}

export interface StrokeAssembler {
  /** Feed one event. Returns every stroke that COMPLETED on it — usually none. */
  push(ev: EvdevEvent): RawStroke[]
  /** Contacts currently down, across every path. */
  openCount(): number
}

interface Contact {
  pointerId: number
  samples: RawSample[]
  startTsMs: number
  concurrent: boolean
  droppedSamples: number
}

interface SlotState {
  x: number | null
  y: number | null
  pressure: number | null
  /** A position changed in this frame. */
  dirty: boolean
  opening: boolean
  closing: boolean
  contact: Contact | null
}

interface PathState {
  slot: number
  slots: Map<number, SlotState>
}

function emptySlot(): SlotState {
  return { x: null, y: null, pressure: null, dirty: false, opening: false, closing: false, contact: null }
}

export function createStrokeAssembler(opts: StrokeAssemblerOpts): StrokeAssembler {
  const paths = new Map<string, PathState>()

  function stateFor(path: string): PathState {
    let st = paths.get(path)
    if (!st) {
      st = { slot: 0, slots: new Map() }
      paths.set(path, st)
    }
    return st
  }

  function slotFor(st: PathState, slot: number): SlotState {
    let s = st.slots.get(slot)
    if (!s) {
      s = emptySlot()
      st.slots.set(slot, s)
    }
    return s
  }

  function openContacts(): Contact[] {
    const open: Contact[] = []
    for (const st of paths.values()) {
      for (const slot of st.slots.values()) {
        if (slot.contact) open.push(slot.contact)
      }
    }
    return open
  }

  /**
   * Append, or thin. At the cap the MIDDLE-most sample goes, never the first
   * or the last: a stroke's endpoints are what a replay and a report both
   * read, and dropping the oldest instead would silently move a swipe's
   * origin to wherever the finger happened to be when the cap hit.
   */
  function pushSample(contact: Contact, sample: RawSample, maxSamples: number): void {
    contact.samples.push(sample)
    if (contact.samples.length <= maxSamples) return
    contact.samples.splice(Math.floor(contact.samples.length / 2), 1)
    contact.droppedSamples += 1
  }

  function commitFrame(path: string, st: PathState, tsMs: number): RawStroke[] {
    const done: RawStroke[] = []
    for (const [slotId, slot] of st.slots) {
      if (slot.opening && !slot.contact) {
        slot.contact = { pointerId: slotId, samples: [], startTsMs: tsMs, concurrent: false, droppedSamples: 0 }
        slot.opening = false
        // Concurrency is decided as it happens, in both directions: the
        // contact arriving and every contact already down are all marked,
        // so a stroke carries the fact even when the OTHER finger is the one
        // that lifted first.
        const open = openContacts()
        if (open.length > 1) for (const c of open) c.concurrent = true
      }
      const contact = slot.contact
      if (contact && slot.x !== null && slot.y !== null && (slot.dirty || contact.samples.length === 0)) {
        pushSample(contact, { x: slot.x, y: slot.y, tsMs, pressure: slot.pressure }, opts.maxSamples)
      }
      slot.dirty = false
      if (slot.closing) {
        slot.closing = false
        if (contact && contact.samples.length > 0) {
          done.push({
            path,
            pointerId: contact.pointerId,
            samples: contact.samples,
            startTsMs: contact.startTsMs,
            endTsMs: tsMs,
            concurrent: contact.concurrent,
            droppedSamples: contact.droppedSamples,
          })
        }
        slot.contact = null
        // A slot with nothing in it is dropped so a 10-slot panel does not
        // keep ten dead entries alive for the life of the capture.
        if (!slot.contact) st.slots.delete(slotId)
      }
    }
    return done
  }

  return {
    push(ev) {
      const profile = opts.profileFor(ev.path)
      if (!profile) return []
      const st = stateFor(ev.path)
      const tsMs = ev.tsMs ?? opts.now()

      if (ev.type === EV_ABS) {
        switch (ev.code) {
          case ABS_MT_SLOT:
            st.slot = ev.value
            return []
          case ABS_MT_TRACKING_ID: {
            if (profile.protocol !== 'mt-b') return []
            const slot = slotFor(st, st.slot)
            if (ev.value >= 0) {
              if (!slot.contact) slot.opening = true
            } else if (slot.contact) {
              slot.closing = true
            } else {
              // A lift for a contact this capture never saw open — it was
              // already down when the stream started. Nothing to emit, and
              // the slot state is reset rather than left half-open.
              slot.opening = false
            }
            return []
          }
          case ABS_MT_POSITION_X:
          case ABS_X: {
            const slot = slotFor(st, st.slot)
            slot.x = ev.value
            slot.dirty = true
            return []
          }
          case ABS_MT_POSITION_Y:
          case ABS_Y: {
            const slot = slotFor(st, st.slot)
            slot.y = ev.value
            slot.dirty = true
            return []
          }
          case ABS_MT_PRESSURE:
          case ABS_PRESSURE: {
            const slot = slotFor(st, st.slot)
            slot.pressure = ev.value
            return []
          }
          default:
            return []
        }
      }

      if (ev.type === EV_KEY && ev.code === BTN_TOUCH) {
        // Protocol B panels emit `BTN_TOUCH` too, as a summary of "some
        // finger is down". Acting on it there would open a second, phantom
        // contact beside the slot that already owns the real one.
        if (profile.protocol === 'mt-b') return []
        const slot = slotFor(st, 0)
        if (ev.value === 1) {
          if (!slot.contact) slot.opening = true
        } else if (slot.contact) {
          slot.closing = true
        }
        return []
      }

      if (ev.type === EV_SYN && ev.code === SYN_REPORT) return commitFrame(ev.path, st, tsMs)

      return []
    },

    openCount() {
      return openContacts().length
    },
  }
}
