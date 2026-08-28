# Google automation pack

Account and device automation for the Google apps on a farm device.

> **Status: early, measuring (0.2.0).** Two members: `snapshot-accounts`
> (read-only) and `open-register` (walks to the account-creation page, stops
> there). Both have run on the farm's hardware; `open-register` has proven the
> full walk to the register page on a signed-out moto g06 power.

## What is here

| File | What it is |
|---|---|
| `src/index.ts` | The manifest. No service, no Studio screen, no declared permissions — see below. |
| `src/snapshot-accounts.ts` | Read-only member. Opens the device accounts screen, saves the UI tree and a screenshot, reads which addresses are listed. Never taps anything. |
| `src/open-register.ts` | The navigating member. Google app → account sheet → "Login" → "Buat akun" → "Untuk penggunaan pribadi saya" → the register page. Never fills a field, never submits. |
| `src/tree.ts` | Dump-and-walk primitives (`flatten`, `all`, `rowsById`, `visibleStrings`). |
| `src/accounts.ts` | The KV key and the address parse. |

## What `open-register` measured on hardware

The whole walk to the register page ran green on the farm's signed-out
device (moto g06 power, Indonesian UI). Each hop's tree is saved as a job
artifact, which is what a future form-filling member builds its selectors
from:

1. the home screen's account disc: `googleapp_account_disc_container`;
2. the account sheet's first row on a signed-out device is exactly "Login"
   (a signed-in device shows "Tambahkan akun lain" instead — both matched);
3. the sign-in chooser's "Buat akun" row (one scroll down);
4. the audience chooser's "Untuk penggunaan pribadi saya" row.

It stops on "Buat Akun Google — Masukkan nama Anda" and never submits
anything.

## Why the first member is read-only, and why that is the point

Every later member needs selectors, and selectors have to be measured on the
hardware they run against. `plugins/tiktok-automation-pack/src/index.ts`'s
header is the worked example in this repo: resource ids, bounds, and the three
regions a swipe must avoid, all read off one real device, and every one of them
load-bearing.

This pack's register-side selectors now have that treatment (see
"`open-register`" above); the settings side has not yet. So
`snapshot-accounts`' most valuable output is still not `accounts` — it is
`uiTreeArtifactId`: the real tree, from a real device, which is what the next
settings-side member's selectors get written from instead of a guess.

## What is inference right now, stated plainly

`plugins/mikrotik-routing/src/service/schemas.ts`'s header records what this
repo already paid for an inferred shape presented as a fact: 46 rows of
`invalid_type` on the owner's real router, for a field nothing read. Two things
here are inference, and both report which:

1. **The settings-activity ladder** (`ACCOUNT_SCREENS`). Samsung One UI, AOSP
   and other skins disagree on the activity name, and a wrong one is a silent
   no-op — the launch succeeds, some other screen appears, and the dump is of
   the wrong thing. That is why it is a ladder and why the result carries
   `openedVia`.
2. **The address parse.** Anchored to a whole trimmed label, so a support
   address in a settings footer is not read as an account. It reports
   `evidence`, because an empty list means two unrelated things — "no account
   on this device" and "not the screen we thought it was" — and collapsing them
   is the quiet lie plan 134 spent a milestone removing from path health.

## Editing this pack

`packages/core/packs/` is seeded **once**, keyed on `${name}@${version}`
(`packages/core/src/plugins/seed-embedded.ts`). A rebuilt bundle at an unchanged
version is skipped on every later boot — the change sits in the repo, fully
tested, and never reaches a browser. So editing anything under `src/` means:

1. bump `package.json`, `src/index.ts`'s `version:`, and `src/index.test.ts`'s
   assertion — all three;
2. add the reason to the changelog block in `src/index.ts`;
3. `bun run build:packs`.

A seeded version is **staged, not activated**. The operator activates it on the
Plugins page.

## Permissions

None declared, deliberately. The list is what an operator is shown and consents
to at install (plan 109 §4.1), and it is meant to be exhaustive. Nothing here
calls `ctx.farm`, so the honest list is empty; an undeclared capability is
refused at the point of use (`E_FARM_UNDECLARED`) rather than granted quietly.
`src/index.test.ts` fails if a service appears without that being a deliberate
edit.

## Commands

```bash
bun run --cwd plugins/google-automation-pack test   # this pack's own tests
bun run build:packs                                  # rebuild the embedded bundle
```
