# Plan 904 — Warm-up in SMM, wave 4 : the Studio screen

> Status: implemented — verified by a smoke on real hardware (see §6).
> Ships: plugins/social-media-manager/src/ui/parts/warmup.tsx
> Depends on: plan 900 (D4, D5), plans 901, 902, 903
> Spec references: §4.7, §12

## 1. Goals

- Warm-up is its own destination, so an operator never wonders which kind of
  session they are looking at.
- A session can be planned and watched without touching an API.
- The two session lists cannot mix.

## 2. Non-goals

- Editing a running session's settings, or per-style weighting in the form.
  `styleWeights` exists in the model (plan 901) and has no control yet; the
  form covers what the rotation's own params covered.
- Removing `smm/warmup-rotation` (wave 5).

## 3. The decision that needed justifying

`ui/index.tsx` carries the owner's verdict on the previous layout —
*"saya minta menunya sama aja jadi satu dong jangan dibedakan"* — after which
this plugin went from three sidebar entries to one.

This adds a second, and that is not a reversal. The earlier complaint was three
entries for **one job**: upload a folder, spread it, watch it. Warming up is a
different job — no videos, no posts, and the question it answers is "what did
this phone do today" rather than "where did this video get to". The brief for
this screen said exactly that: *"ada sesi auto post dan sesi warmup, jadi biar
ga ketukar usernya"*.

The rule is unchanged: **one entry per job.** Only the count of jobs changed.

So the separation is at the source, not in the presentation: `loadAll` in
`sessions.tsx` filters to `kind !== 'warmup'` and `WarmupPanel` filters to
`kind === 'warmup'`. A mixed list would put a Retry that re-sends videos onto a
session that has none.

## 4. What the screen does

| place | what it is |
|---|---|
| **Warm-up** | Every warm-up session, newest first: title, its keywords, platforms, progress line, age |
| **New warm-up** | Title, platforms, a label filter, keywords, and the eight numbers the rotation's params exposed |
| **A session** | One row per phone per phase: phone, platform, style, state, and every activity with its own state and error |

The form counts the fleet **the way the planner does**: how many phones the
label picks, and how many of those carry one of the chosen platforms. Those are
different numbers and the operator meets the difference before pressing Create
rather than in a session where most rows say "no label".

One bundle, two registrations: a second entry file would be a second build for
one screen's worth of code.

## 5. Acceptance criteria

| # | criterion | how |
|---|---|---|
| 1 | ~~Two nav entries, two views, each naming its own~~ **Reverted 2026-09-20** (smm 0.56.0): ONE entry, `Social Media Manager`, with warm-up as a tab. The owner overruled plan 900 D5 after using it — see D5 for why the original reasoning was wrong | `index.test.ts` — "one entry, for the whole product" |
| 2 | Both views come from `index.js` | same file |
| 3 | Social posts shows no warm-up session | `loadAll`'s filter; smoke §6 |
| 4 | Warm-up shows no post session | `WarmupPanel`'s filter; smoke §6 |
| 5 | The form reaches `smm/add-warmup` and lands on the new session | smoke §6 |

## 6. Smoke (Studio has no tests — plan 200 §8.3)

Run 2026-09-20 against a local core with a moto g06 power attached, `smm@0.53.0`
installed as a real `.enkaku` package so the UI assets were served:

1. The sidebar carries **Social posts** and **Warm-up** as separate entries.
2. Warm-up opens on its empty state and its New warm-up button.
3. The form renders every control, and its reach line read **"14 phones chosen,
   2 of them carry one of these platforms"** — the planner's own rule, shown
   before Create.
4. Create ran `smm/add-warmup` (job `success`) and landed on the new session,
   headed *"2 waiting, 12 skipped of 14 phones"*.
5. The rows were right: twelve phones `skipped`, each carrying the sentence
   *"This phone carries no label for any of this session's platforms…"*; the
   moto given `youtube` and the style "Watch, home, a channel and the profile"
   with its four activities listed.
6. The router then dispatched the first activity — `youtube/watch-video`
   `running` on the phone, the row reading `state=running, queued=1`.

Step 4 also closes plan 903 §7.3, which recorded `add-warmup` as not yet run.

### 6.1 A trap worth writing down

The first install used `POST /api/plugins` with a JSON body carrying the UI
assets. `StageBody` **has no `ui` field**, so they were dropped in silence and
the view rendered "this view's code could not be loaded" — which looks exactly
like a broken component. UI assets only reach a farm through the `.enkaku`
package path (`writePluginPackage`, `application/octet-stream`).

## 7. Risks

| risk | mitigation |
|---|---|
| Two entries read as clutter on a small farm | They are two jobs; §3. If a farm never warms up, the entry is one line in a sidebar that already lists per-plugin destinations |
| `styleWeights` has no control, so a stored weight is invisible | Named as a non-goal; the model keeps unknown ids, so a later control cannot lose them |

## 8. Open questions

None new.
