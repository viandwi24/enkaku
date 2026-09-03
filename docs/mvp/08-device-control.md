# MVP 08 — Device Control: mouse, keyboard, hotkeys, clipboard

> Status: decided in direction (CEO, 2026-09-03); specification proposed here.
> As stated by the CEO: input and gestures fall far short of Panda. In Panda's device control popup the mouse moves, touches, and swipes the screen; there are hotkeys such as Escape; and the keyboard is forwarded straight to the Android device, including Escape, Enter, Tab, and typing. Any mechanism is acceptable, including the guest agent.
> Feature name from now on: **Device Control** (the modal or popup that shows one device live and accepts input).
> Related: MVP 01 §1.5 (input path latency), MVP 04 (control marker), `packages/studio/src/components/LiveView.tsx`, `packages/drivers/src/input/`, `packages/scrcpy/src/control/messages.ts`, `packages/scrcpy/src/version.ts:31-48`, `apps/guest-agent` (`EnkakuIme`, `text.commit`).

---

## 0. What exists today

**Studio (`LiveView.tsx`)**

- Pointer: `input.tap` (with hold), `input.swipe`, `input.gesture` (a drag, buffered until pointer-up, `:34`). No wheel handler, no right or middle click, no pinch, no double-click semantics.
- Keyboard (`onKeyDown`, `:857-884`): exactly three keys mapped, `Enter`, `Backspace`, `Escape → BACK`. Everything else is either ignored or collected as text and flushed as `input.text` after `TEXT_DEBOUNCE_MS = 500` (`:27`). No Tab, arrows, Delete, modifiers, function keys, or shortcuts. Disabled entirely in `compact` mode (`:1161`).
- Toolbar keys (`:898-921`): Back, Home, Recents, Power, Volume up/down/mute, Wake, Sleep.
- Clipboard: paste chord is let through to `input.text` (`:833`); no device-to-host direction.

**Device side (already available, unused by Studio)**

- scrcpy control messages (`version.ts:31-48`): `INJECT_KEYCODE`, `INJECT_TEXT`, `INJECT_TOUCH_EVENT`, `INJECT_SCROLL_EVENT`, `BACK_OR_SCREEN_ON`, `EXPAND_NOTIFICATION_PANEL`, `EXPAND_SETTINGS_PANEL`, `COLLAPSE_PANELS`, `GET_CLIPBOARD`, `SET_CLIPBOARD`, `SET_DISPLAY_POWER`, `ROTATE_DEVICE`, `UHID_CREATE/INPUT/DESTROY`, `OPEN_HARD_KEYBOARD_SETTINGS`, `START_APP`.
- UHID (a virtual HID device on the phone, API 29 and above, `UHID_MIN_API`) is already used for a pointer (`packages/scrcpy/src/hid/pointer.ts`). A UHID **keyboard** is the same mechanism and is what scrcpy itself uses for physical-keyboard passthrough.
- The driver exposes `tap`, `swipe`, `key`, `text`, `gesture`, `typeText` (`scrcpy-input.ts:49-116`). No scroll, no key down/up pair, no HID keyboard.
- The guest agent has an IME (`EnkakuIme`) and `text.commit` for reliable text entry including non-Latin scripts; this is the top rung of the plan 90 text ladder.

The gap is entirely in Studio and the driver's API surface. Nothing new is needed on the phone.

## 1. Specification

### 1.1 Pointer

| Host gesture | Device action | Mechanism |
|---|---|---|
| Click | tap | `INJECT_TOUCH_EVENT` down/up; hold from the browser's measured press length, no synthetic minimum beyond what scrcpy needs |
| Press and hold | long press | same, hold = real duration |
| Drag | touch move, **streamed live** at 8 ms sampling (MVP 01 §4 step 2) | `INJECT_TOUCH_EVENT` move per sample, sent as it happens |
| Wheel | scroll at the pointer, vertical; Shift+wheel horizontal | `INJECT_SCROLL_EVENT` with the pointer position and h/v deltas |
| Right click | Back | `BACK_OR_SCREEN_ON` |
| Middle click | Home | `INJECT_KEYCODE HOME` |
| Double click | two taps, no special handling | |
| Ctrl+drag (Cmd on macOS) | pinch: two touch points mirrored around the screen centre | two `INJECT_TOUCH_EVENT` pointers (ids 0 and 1) |
| Alt+drag | pinch around the drag's start point | same |
| Pointer leaves the canvas mid-drag | touch up at the last point | never leaves the device with a stuck finger |

### 1.2 Keyboard: three layers, one rule

**The rule: while Device Control has focus, every key goes to the device.** Focus is taken by clicking the screen and shown by a visible frame; it is released by clicking outside, by the release chord, or when the modal closes. The browser never sees a key while focus is held, including Tab and browser shortcuts.

| Layer | What | Mechanism |
|---|---|---|
| Hotkeys (host-side, with the modifier held) | Esc → Back (always, no modifier); Alt+H Home; Alt+S Recents; Alt+P power; Alt+R rotate; Alt+N notifications; Alt+M settings panel; Alt+O collapse panels; Alt+F fullscreen; Alt+K show/hide the toolbar; Alt+C copy device clipboard to host; Alt+V paste host clipboard to device; Alt+Shift+K release focus | `INJECT_KEYCODE` and the panel/rotate/clipboard control messages. On macOS the modifier is Cmd; the map is one table in `@enkaku/protocol` so scripts and docs read the same list |
| Key passthrough | Every other key, with real down and up, including Tab, arrows, Delete, Home/End, PageUp/Down, F-keys, and modifier combinations (Ctrl+A, Ctrl+Z, Shift+arrows) | **UHID keyboard** on API 29 and above: `UHID_CREATE` once per session with a standard keyboard report descriptor, `UHID_INPUT` per key event. Below API 29: `INJECT_KEYCODE` per key with the meta state, which loses a few combinations but keeps the same behaviour |
| Text | Typing printable characters; paste; IME-driven scripts (Indonesian is Latin, but Thai, Arabic, CJK are not) | Printable keys go through the UHID keyboard like any other key, so the device's own keyboard layout applies and there is no debounce. **Paste and anything the UHID path cannot express** (non-Latin scripts, emoji, long text) go through the guest agent IME `text.commit`, falling back to `INJECT_TEXT` |

The 500 ms text debounce is deleted. A key press reaches the device as one HID report, on the same socket and in the same lane as touch.

UHID side effect to handle: when a virtual hardware keyboard appears, Android may hide the soft keyboard. Device Control shows a one-time hint and a toolbar toggle that sends `OPEN_HARD_KEYBOARD_SETTINGS`; the "show soft keyboard with hardware keyboard" preference is per device and persists.

### 1.3 Clipboard, both directions

- Host to device: Alt+V or the toolbar button sends `SET_CLIPBOARD` with `paste: true`; long or non-Latin content goes through the IME instead.
- Device to host: scrcpy sends a device message on every device-side copy (`control/device-messages.ts`); Studio keeps the last value and Alt+C writes it to the host clipboard. This needs a user gesture in the browser, which the hotkey is.

### 1.4 Toolbar

Back, Home, Recents, Power, Volume up/down, Rotate, Notifications, Screenshot (saves a PNG from the current frame), Record (existing action recording), Paste, Copy, Keyboard (soft-keyboard toggle), Keep awake, Fullscreen. Every toolbar button has the hotkey in its tooltip, and the hotkey table is the single source for both.

### 1.5 Multi-device

Device Control is one device. Sending the same input to several devices is a bulk feature (mirror, deferred in MVP 06) built later on top of this spec, not the other way round.

## 2. What changes where

| Layer | Change |
|---|---|
| `@enkaku/protocol` | `input.scroll`, `input.keyEvent` (down/up with meta), `input.pinch`, `clipboard.get/set`; the hotkey table; `input.text` keeps its request/reply shape |
| `packages/drivers` input layer | `scroll()`, `keyDown()/keyUp()` via UHID with `INJECT_KEYCODE` fallback, `pinch()`, `setClipboard()/getClipboard()`; the UHID keyboard is created lazily on the first key and destroyed with the session |
| `packages/session` arbiter | unchanged lanes; key events go in the `keys` lane, scroll and pinch in `pointer` |
| Studio `LiveView` | live drag, wheel, mouse buttons, focus model, hotkey table, key passthrough, clipboard, toolbar; `compact` no longer disables the keyboard, it only hides the toolbar |
| Settings | per device: soft-keyboard-with-hardware preference; per user: hotkey modifier (Alt or Cmd), show touches |

## 3. Removed

`TEXT_DEBOUNCE_MS` and the text-collection branch in `onKeyDown`; the three-key map; the `compact` keyboard disable; the synthetic 40–120 ms tap hold as a default (kept only as a script-side option for humanised automation).

## 4. Acceptance

- Typing a sentence in a text field on the device shows each character as it is typed, with no batching.
- Tab moves focus between fields in a form on the device; arrows move a cursor; Ctrl+A selects all.
- Esc goes back; right click goes back; wheel scrolls a list; Ctrl+drag zooms a map.
- Copy on the device, Alt+C, paste on the host: the text arrives. And the reverse.
- All of the above measured on the lab device with the MVP 01 latency overlay, so the input leg has a number too.

## 5. Open points

1. The hotkey modifier: Alt everywhere, or Cmd on macOS. Proposed: Alt on Windows and Linux, Cmd on macOS, user-switchable.
2. Whether hotkeys are shown as an overlay on first open. Proposed: yes, once, dismissable, with the table available from the toolbar.
