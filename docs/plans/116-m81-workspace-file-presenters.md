# Plan 116 — M81 : A workspace file is opened by a presenter, and only some of them can edit

> Status: implemented — **all six steps (116.1–116.6) shipped 2026-08-18**, the same day plan 115 landed the storage seam beneath them. Plan 115 answered *where the bytes live*; this plan answers *how a file is opened and whether it can be edited*. A text file reaches a presenter that views and edits; an image and a video reach presenters that only view — and that read-only state is a declared capability rendered as a sentence from the registry, not a Save button that happens to be missing. **What shipped:** `GET`/`HEAD /api/workspace/file` with `Range` support and §3.5's safety headers; the `FilePresenter` seam, registry and `resolvePresenter`; text (view+edit, on plan 64's CAS), image, video and download/fallback presenters; the page rewired to resolve rather than hardcode; and 116.6's metadata-without-bytes fix. **Verified 2026-08-18, re-run independently by the orchestrator:** `packages/core/src/api/workspace.test.ts` 25 pass / 0 fail; Studio's `components/workspace/` + `app/workspace/` 35 pass / 0 fail (`--isolate`); `bun run typecheck` clean in all 17 packages. **Verified LIVE against the running core, not only in tests:** `HEAD` returns the `ETag` (the sha256 that is also the CAS token), `nosniff` and the sandbox CSP with no body; `Range: bytes=0-9` returns 206 with `Content-Range: bytes 0-9/73130` and exactly ten bytes, proving the inclusive end; and an uploaded `.html` and `.svg` each carrying a real `<script>` payload were both forced to `Content-Disposition: attachment` rather than rendered. **Three corrections the build made to this document, each caught by a builder rather than by review:** (1) §4.1 specified `JSX.Element`, which does not exist under React 19 — three files that copied it verbatim failed to compile until it became `ReactElement`. (2) §3.5 listed `text/*` wholesale while separately promising `text/html` would download; the carve-out had to be stated, and the secure reading was implemented. (3) §5's 116.6 instruction said to register `HEAD` explicitly — but Hono 4.12.33 intercepts `HEAD` unconditionally *before* the router, so a separately-registered route is unreachable dead code; the builder read `hono-base.js` rather than trusting the instruction, and branched inside the `GET` handler instead. **One defect found after the first three steps landed, promoted to a step rather than patched quietly:** finding P7 — the page called `readWorkspaceFile` for every file, so opening a 200 MB video pulled it base64-encoded through the capability API purely to learn its type. 116.6 closed it, and criterion 10 now locks it down with a test that was proven to fail when the gate is removed. **Both security-critical tests were proven to fail before being trusted:** emptying the document-type list turned the attachment tests red, and removing the presenter gate turned the criterion-10 test red; each was restored and diffed byte-identical.
> Depends on: Plan 115 (M80) — the content store, `POST /api/workspace/file`, and Upload/Rename. Plan 64 — the workspace page and its store.
> Deliberately does NOT depend on: an image or video *editor*. §2 records that both are out of scope by the owner's own instruction, and §3.2 is what makes their absence legible instead of silent.
> Spec references: §12 (data model), §19 (Studio screens)
> Ships: packages/studio/src/components/workspace/presenters/index.ts

---

## 0. Evidence

Checked against the code on 2026-08-18, after plan 115.

| # | Finding | Consequence |
|---|---|---|
| **P1** | **The workspace page renders every file through one `Textarea`.** There is no branch on content type anywhere on that page. | The `video/mp4` uploaded during plan 115's own verification would open as base64 text in an edit box. This is the concrete defect the plan fixes, not a hypothetical. |
| **P2** | **There is no `GET` route for a workspace file's bytes.** `packages/core/src/api/workspace.ts` has `POST /file` and nothing else. | An `<img>` or `<video>` has nothing to point at. A viewer cannot be built without this first. |
| **P3** | **`fs.read` returns non-text content base64-encoded** through the capability API. | Fine for a script reading a caption file; unusable for a browser showing a 50 MB video — it inflates by a third, arrives as one JSON string, and cannot seek. |
| **P4** | **The artifact content route sets `content-type` and nothing else** — no `X-Content-Type-Options`, no `Content-Disposition`, no CSP. | It is the nearest precedent and it must NOT be copied for this. See P5. |
| **P5** | **Studio is served from the core's own origin** (`docs/plans/00-overview.md` §3: static export, served by the core — single origin). | Serving operator-uploaded bytes inline from that origin is a stored-XSS vector: an uploaded `.html`, `.svg` or `.xhtml` would execute with Studio's own origin, session and API access. §3.5 is the rule that closes it. |
| **P7** | **The page reads a file's BYTES before it knows what the file is.** `loadFile` calls `readWorkspaceFile(path)` unconditionally, and that goes through `fs.read`, which base64-encodes binary (P3). | Found during 116.2's own build and confirmed by the orchestrator: clicking a 200 MB video would pull the whole thing through the capability API — inflated by a third, as one JSON string — purely to learn its `contentType` and size, *before* a presenter is chosen. The viewers themselves are innocent: `<img>`/`<video>` point at the GET route. The defect is in how metadata is obtained. Step 116.6 closes it. |
| **P6** | **Plan 115 already introduced a `ContentDriver` seam**, and the owner used the word "driver" for this one too. | Two different seams. §3.1 keeps them apart by name so a future reader cannot confuse "where the bytes live" with "how the file is shown". |

## 1. Goals

1. **A file opens in a presenter chosen by what it is** — text, image, video — and not in whatever the page happens to render.
2. **A presenter states what it can do.** Text views and edits. Image and video view only.
3. **Read-only is explained, not implied.** A video shows why it cannot be edited, rather than a Save button that is missing for no stated reason.
4. **A new presenter is one file plus one registry entry**, with nothing else in the page to change.
5. **Bytes reach the browser through a real HTTP GET**, streamable and seekable, never base64 through the capability API.
6. **Serving operator-uploaded content cannot execute in Studio's origin.**
7. An unknown type is handled honestly: named, offered as a download, never rendered as garbage.

## 2. Non-goals

- **An image editor or a video editor.** The owner's own instruction: skipped for now. §3.2 makes their absence a declared fact rather than a gap to be discovered.
- **Transcoding, thumbnails, or a media library.** The viewer plays what the browser can play; a codec the browser refuses is reported as such.
- **Editing any binary format.** Hex editors, EXIF, metadata — none of it.
- **Touching the storage seam.** Plan 115's `ContentDriver` is finished and is not reopened here.
- **Fixing the artifact content route's own missing headers (P4).** Real, out of scope, recorded in §9 Q2 so it is not lost.

## 3. Design decisions

### 3.1 Two seams, two names, deliberately

Plan 115's **storage driver** answers *where the bytes live*. This plan's **presenter** answers *how the file is shown and whether it can be edited*. The owner called both "driver", which is right in prose and would be a bug in code: a reader of `driver` in `packages/core/src/workspace/` and `driver` in `packages/studio/src/components/workspace/` would reasonably assume one registry.

So: `ContentDriver` stays the storage seam. The new one is `FilePresenter`. Neither file mentions the other's word.

### 3.2 A presenter declares its capabilities; the absence of an editor is data

```ts
capabilities: { view: true, edit: false }
```

`edit: false` is not the lack of a feature — it is what the page reads to decide whether to render a Save control at all, and what it shows in the file's own header: *"Video files can be viewed but not edited."* That sentence is generated from the registry, so adding a video editor later flips one boolean and the explanation stops appearing on its own.

A presenter with `view: false` is not expressible. Every presenter can show something, or it is not a presenter.

### 3.3 Selection is by content type, with an honest floor

The registry is an ordered list; the first presenter whose `match` accepts the file's `contentType` wins. `text/*` and the JSON/JS/TS family go to the text presenter, `image/*` to the image viewer, `video/*` to the video viewer.

Everything else reaches the **fallback**, which is a real presenter and not an error state: it names the type and size, offers a download, and says no viewer is installed for it. A file manager that shows a blank pane for an unknown type teaches an operator that the app is broken.

### 3.4 Bytes reach the browser over HTTP, with ranges

`GET /api/workspace/file?path=…` returns the raw bytes with the stored `contentType`, `Content-Length`, and **`Range` support** — without which a `<video>` element cannot seek, and a browser may refuse to play at all. It reads through the workspace store, so it works identically for an `inline` row and an `fs` row and will work for `s3` on the day that exists.

`fs.read` is untouched: it stays the capability a **script** uses.

### 3.5 Operator-uploaded bytes may never execute in Studio's origin

The rule, and it is not negotiable by a future presenter:

- **`X-Content-Type-Options: nosniff`** on every response, so a mislabelled file cannot be re-interpreted by the browser.
- **An allow-list decides what may be served inline at all**: `text/*`, `image/*`, `video/*`, `audio/*`, `application/json` — **each family minus the document types inside it that can carry script**: `text/html` is carved out of `text/*` exactly as `image/svg+xml` is carved out of `image/*`, and `application/xhtml+xml` never enters. Everything outside the allow-list, and every carve-out, is served `Content-Disposition: attachment`, which makes it a download rather than a page.

  *(This paragraph originally listed `text/*` wholesale while separately promising that `text/html` would be an attachment — two statements that only agree if the carve-out is stated, which it was not. Step 116.1's builder caught the contradiction and implemented the secure reading; the wording is corrected here rather than left for the next reader to re-derive.)*
- **`Content-Security-Policy: sandbox`** on the response, so even a type that slips through cannot run script.

SVG is excluded from the image allow-list specifically because it is a document that can carry script, not an image format in the sense that matters here. That is the one exclusion a reviewer will question, so it is written down.

### 3.6 A presenter states its own ceiling

A text presenter that loads a 200 MB file into a `Textarea` hangs the tab. Each presenter declares `maxBytes`; over it, the page shows the file's metadata and a download instead of the viewer, and says which limit was hit. The text presenter's ceiling is small (it is an editor), the image and video ones are large (the browser streams them).

### 3.7 Editing keeps plan 64's CAS, unchanged

Save still goes through the existing `fs.write` path with the file's `hash` as `ifMatch`. Nothing about concurrency changes; the text presenter is a new front end onto the write that already exists.

## 4. Technical design

### 4.1 The presenter seam

```ts
export interface FilePresenter {
  id: 'text' | 'image' | 'video' | 'download'
  /** First match wins, so order in the registry is meaning, not style. */
  match(file: { contentType: string; path: string }): boolean
  capabilities: { view: true; edit: boolean }
  /** Over this, the page shows metadata and a download instead (§3.6). */
  maxBytes: number
  /** Why this presenter cannot edit — rendered verbatim; required when `edit` is false. */
  readOnlyReason?: string
  Component: (props: PresenterProps) => ReactElement
}
```

> `ReactElement`, imported from `react` — **not** the bare `JSX.Element` this section originally wrote. Studio is on React 19, where the JSX types live under `declare module 'react'` and there is no globally-ambient `JSX` namespace; no other file in `packages/studio/src` references one. Written as `JSX.Element`, the interface fails with `TS2503: Cannot find namespace 'JSX'` — which is exactly what happened to the three files that copied it verbatim from here before step 116.3 caught it.

```ts

export interface PresenterProps {
  path: string
  meta: WorkspaceFileMeta
  /** The GET URL from §4.2 — an image/video presenter uses this, never the bytes. */
  src: string
  /** Text only: loaded content, and the CAS-guarded save. */
  text?: { value: string; onChange(next: string): void; onSave(): Promise<void>; dirty: boolean }
}
```

### 4.2 `GET /api/workspace/file?path=…`

Same auth as the upload route. Streams through the store, honours `Range` (206 with `Content-Range`, and `Accept-Ranges: bytes` on a full response), and applies §3.5's headers on every path including errors.

### 4.3 The page

The workspace page stops owning "how a file is rendered". It resolves the presenter, renders `Component`, and renders the read-only sentence when `edit` is false. The Save control is bound to `capabilities.edit`, not to a hardcoded assumption.

## 5. Implementation steps

| step | what |
|---|---|
| **116.1** | `GET /api/workspace/file` — streaming, `Range`, and §3.5's safety headers with the inline allow-list. |
| **116.2** | The `FilePresenter` seam, the registry, the **text** presenter (view + edit, replacing the page's `Textarea`), the **fallback** presenter, and the page wiring that resolves and renders them. |
| **116.3** | The **image** viewer (`view` only) and the **video** viewer (`view` only, seeking through 116.1's ranges), each with its `readOnlyReason`. |
| **116.6** | **Metadata without bytes** (P7): `HEAD /api/workspace/file?path=…` answers `Content-Type`/`Content-Length` with no body, the page resolves its presenter from that, and only the text presenter then fetches content. Ordered before the tests because it changes what they must cover. |
| **116.4** | Tests, one pass at the end, scoped. |
| **116.5** | Docs: the workspace guide's "what you can open and what you can edit", and `docs/spec.md` §19. |

## 6. Acceptance criteria

1. A `.txt` opens in the text presenter, edits, and saves through the existing CAS.
2. A `.mp4` opens in the video presenter, plays, and **seeks** — proving 116.1's `Range` support.
3. A `.png` opens in the image presenter.
4. Neither the video nor the image shows a Save control, and each states in words why it cannot be edited.
5. An unknown type reaches the fallback: named, sized, downloadable, with no blank pane and no error.
6. An uploaded `.html` or `.svg` is served as an attachment, never inline, and carries `nosniff` and the sandbox CSP.
7. A file over a presenter's `maxBytes` shows metadata and a download, naming the limit.
8. Adding a presenter requires one new file and one registry line — demonstrated by the fact that 116.3 changes no page code.
9. Plan 115's upload, rename, create, delete and the folder-mode post still work unchanged.
10. **Opening a large video transfers no file bytes through the capability API** — the page learns its type and size from headers, and only the text presenter ever fetches content (P7).

## 7. Test plan

Scoped, one pass: the route's `Range` arithmetic (including an unsatisfiable range and a suffix range), the inline-vs-attachment allow-list including the SVG exclusion, presenter selection for each type and the fallback, the `maxBytes` refusal, and that the Save control is bound to `capabilities.edit`. Studio tests run scoped to the workspace components only — never the full suite.

## 8. Risks

| risk | mitigation |
|---|---|
| **Serving operator content becomes stored XSS.** The nearest precedent (P4) has none of the defences. | §3.5, and criterion 6 tests it with the two file types that actually carry the risk. |
| **A large file hangs the tab.** | §3.6's per-presenter ceiling, and criterion 7. |
| **"Driver" meaning two things.** | §3.1: `ContentDriver` and `FilePresenter`, neither borrowing the other's word. |
| **A browser that refuses a codec** looks like a broken viewer. | The video presenter reports the element's own error rather than showing a black rectangle. |
| **Range handling written by hand is easy to get subtly wrong** (off-by-one on the inclusive end, suffix ranges). | Criterion 2 plus the arithmetic tests named in §7; the inclusive-end convention is stated in the route's own comment. |

## 9. Open questions

**Q1 — Does an audio presenter ship now?** `audio/*` is in the inline allow-list and would be a near-copy of the video one. Not built: no one has asked, and §3.3's fallback handles it honestly in the meantime.

**Q2 — Does `GET /api/artifacts/:id/content` get the same headers?** It has the same exposure and none of the defences (P4). Out of scope here, and a real finding — it should be its own change rather than smuggled into a Studio plan.

**Q3 — Should reading a workspace file be gated on the upload config?** Step 116.1 mounted `GET /file` behind the same `deps.upload` presence check as `POST /file`, so a farm that wired the routes without upload would also lose reading. `daemon.ts` always supplies it, so nothing is broken today — but the coupling reads as accidental (a *read* gated on an *upload* setting) rather than intended. *Recommendation: split the dependency when someone genuinely wants read-only workspaces; not worth churn before then.*

**Q4 — Should the text presenter get syntax highlighting?** The page already publishes scripts from the workspace, so a code editor is a plausible next step. Deliberately unanswered: it is a large dependency decision, and this plan's job is the seam.
