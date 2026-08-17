import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { Button } from './button'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from './alert-dialog'

afterEach(cleanup)

/**
 * Upstream caps neither dialog's height, so a tall one grew past the top and
 * bottom of the screen with no way to reach either end. Reported on the run
 * dialog for a script with many parameters — its Run button was off-screen and
 * unreachable — but it was every dialog in the product.
 *
 * The failure is silent: nothing throws, and it only appears once content is
 * taller than the viewport. `happy-dom` has no layout engine, so this asserts
 * the classes rather than a measured height — the same honest limit the
 * `input-group` test records.
 */
describe('dialogs are capped at the viewport and scroll', () => {
  test('DialogContent', () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const el = baseElement.querySelector('[data-slot="dialog-content"]')
    expect(el?.className).toContain('max-h-[90dvh]')
    expect(el?.className).toContain('overflow-y-auto')
  })

  test('AlertDialogContent — a confirmation can be long too', () => {
    const { baseElement } = render(
      <AlertDialog open>
        <AlertDialogContent>
          <AlertDialogTitle>t</AlertDialogTitle>
        </AlertDialogContent>
      </AlertDialog>,
    )
    const el = baseElement.querySelector('[data-slot="alert-dialog-content"]')
    expect(el?.className).toContain('max-h-[90dvh]')
    expect(el?.className).toContain('overflow-y-auto')
  })
})

/**
 * The non-modal variant (plan 103 §3.2, §5 step 103.1) — H1's own gate,
 * actually run rather than merely described: `<Dialog modal={false}>` paired
 * with `<DialogContent overlay={false}>` must render no backdrop, must not
 * block the rest of the page from receiving input, and Esc must still close
 * it. `docs/plans/103-m68-device-popup-system.md` §3.2's own H1 finding:
 * against the pinned `@radix-ui/react-dialog@1.1.23`, Radix's OWN `Overlay`
 * already returns `null` once `modal={false}` reaches the root — so the
 * first assertion below holds even without `overlay={false}` — but every
 * call site still passes both, per this file's own doc comment on why.
 */
describe('the non-modal variant (plan 103 §3.2, step 103.1)', () => {
  test('overlay={false} + modal={false} renders no backdrop element', () => {
    const { baseElement } = render(
      <Dialog open modal={false}>
        <DialogContent overlay={false}>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
    expect(baseElement.querySelector('[data-slot="dialog-content"]')).toBeTruthy()
  })

  test('the ordinary (modal) path still renders the backdrop — this is an opt-in, not a default change', () => {
    const { baseElement } = render(
      <Dialog open>
        <DialogContent>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    expect(baseElement.querySelector('[data-slot="dialog-overlay"]')).toBeTruthy()
  })

  test('H1 — a keyboard user can reach a control behind a non-modal dialog while it is open', () => {
    const { getByRole } = render(
      <div>
        <Button>Behind the dialog</Button>
        <Dialog open modal={false}>
          <DialogContent overlay={false}>
            <DialogTitle>t</DialogTitle>
            <Button>Inside the dialog</Button>
          </DialogContent>
        </Dialog>
      </div>,
    )
    // A modal dialog's `DialogContentModal` calls Radix's `hideOthers()` on
    // mount, pulling the rest of the page out of the accessibility tree
    // (`aria-hidden` on every sibling). The non-modal path never calls it —
    // asserted here as "the background button is still exposed to an
    // accessibility tree walk", the same thing a screen reader or Tab would
    // see, not merely "the DOM node still exists".
    const behind = getByRole('button', { name: 'Behind the dialog' })
    expect(behind).toBeTruthy()
    expect(behind.closest('[aria-hidden="true"]')).toBeNull()
    // A modal's overlay is `pointer-events: auto` and covers the page,
    // which is what actually stops a click from reaching anything behind
    // it — there is no such element here to intercept the click.
    fireEvent.click(behind)
  })

  test('H1 — Esc still closes a non-modal dialog (Radix\'s DismissableLayer dismiss is unconditional)', () => {
    let open = true
    const onOpenChange = (v: boolean) => {
      open = v
    }
    render(
      <Dialog open={open} modal={false} onOpenChange={onOpenChange}>
        <DialogContent overlay={false}>
          <DialogTitle>t</DialogTitle>
        </DialogContent>
      </Dialog>,
    )
    const dialog = screen.getByRole('dialog')
    fireEvent.keyDown(dialog, { key: 'Escape' })
    expect(open).toBe(false)
  })
})
