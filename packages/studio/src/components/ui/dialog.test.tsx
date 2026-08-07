import { afterEach, describe, expect, test } from 'bun:test'
import { cleanup, renderWithApi } from '@/lib/test/render'
import { Dialog, DialogContent, DialogTitle } from './dialog'
import { AlertDialog, AlertDialogContent, AlertDialogTitle } from './alert-dialog'

process.env.NEXT_PUBLIC_ENKAKU_CORE_URL = 'http://core.test'

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
    const { baseElement } = renderWithApi(
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
    const { baseElement } = renderWithApi(
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
