# MVP 07 — One action model: every action takes a target

> Status: decided in direction (CEO, 2026-09-03); convention proposed here.
> As stated by the CEO: single-device and multi-device actions behave inconsistently. Every control or action API should take multiple devices by default; a single device is a list of one. Read APIs (inspector, details) stay per-device. One Studio component per action, used from every entry point.
> Related: MVP 04 (activities and the policy table), MVP 05 (batches), `packages/core/src/api/devices*.ts`, `transfer.ts`, `network/route-service.ts`, `packages/studio/src/components/*Dialog.tsx`.

---

## 0. Evidence: every action exists twice

| Action | Single-device path | Multi-device path |
|---|---|---|
| Run a script | `POST /api/jobs` | `POST /api/batches` (`RunScriptDialog.tsx:478-481` branches on device count) |
| Install an APK | `POST /api/devices/:id/install` | `InstallBatchDialog` |
| Push / pull a file | `POST /api/devices/:id/push`, `/pull` | `BulkTransferDialog` |
| Network route | `PUT /api/devices/:id/network`, `/network/enable`, `/disable`, `/retry` | `POST /api/devices/network/apply`, `BulkProxyDialog` |
| Screen label | `POST /api/devices/:id/label/apply` | `POST /api/devices/labels/apply` |
| Preparation | `POST /api/devices/:id/preparation` | `POST /api/devices/prep/apply`, `BulkPrepDialog` |
| Connection cutover | `CutoverDialog`, `POST /api/devices/:id/connection/cutover` | `BulkCutoverDialog` |
| Forget | `ForgetDeviceDialog`, `DELETE /api/devices/:id` | `BulkForgetDialog` |
| Target selection | `components/TargetPicker.tsx` + `useTargetSelection.ts` | `components/command/TargetPicker.tsx` + `target-preview.ts` |
| adb command | device Terminal tab, `AdbCommandDialog` | `/console`, `POST /api/command-runs` |

Two implementations of one act, each with its own body shape, error shape, confirmation copy, and tests. The inconsistency users feel is literal.

## 1. The convention

### 1.1 Actions take a target

```
POST /api/actions/<verb>
{
  "target": { "deviceIds": ["…"] } | { "clusterId": "…" } | { "tags": ["…"] },
  ...verb-specific parameters,
  "force": false            // acknowledge policy warnings (MVP 04 §1.3)
}
```

One endpoint per verb, no `/:id/<verb>` routes. A single device is `{ "deviceIds": ["one"] }`. The target shape already exists (`commandRuns.target`, `schedules`, `POST /api/clusters/preview`); it becomes the only shape.

Verbs in the MVP: `run-script`, `run-workflow`, `install`, `push`, `pull`, `adb`, `wake`, `sleep`, `reconnect`, `disconnect`, `cutover`, `forget`, `block`, `unquarantine`, `set-network`, `set-label`, `clear-label`, `set-cluster`, `set-tags`, `prepare`, `retry-prepare`, `reprofile`. Added by MVP 15 from the handoff's generic action set: `screenshot`, `clear-cache`, and bulk `settings`; `set-cluster` is shown as "Move group". The first twelve entries of every action menu are the handoff's list, in its order; the rest sit in an overflow. Plugins add verbs through the capability broker under `<plugin>/<verb>`.

### 1.2 Responses are per device, always

```
202 { "operationId": "…", "results": [ { "deviceId": "…", "status": "accepted" | "skipped" | "forbidden" | "warned", "message": "…", "activityId": "…" } ] }
```

- Partial acceptance is the normal case. Nothing is all-or-nothing unless the verb is physically atomic on one device.
- `forbidden` and `warned` carry the policy sentence from MVP 04. A `warned` device is not started until the caller repeats with `force: true`; Studio shows the sentences once and re-sends.
- Long-running verbs create one activity per device (MVP 04 §1.1); completion arrives on `device.activity`, and `GET /api/operations/:id` returns the same array with final statuses for callers that poll.
- `run-script` and `run-workflow` always create a batch, even for one device. A batch of one is displayed as its single job. This deletes the job-or-batch branch.

### 1.3 Reads stay per device

`GET /api/devices/:id`, `/inspect/*`, `/screenshot`, `/logs`, `/files`, `/monitor`, `/identity`, `/preparation`. The only multi-device read is the list the wall already uses, `GET /api/devices`. A read never accepts a target.

### 1.4 WebSocket input is the one exception

`input.*` messages (tap, swipe, key, text) stay single-device and fire-and-forget: they are a stream, not an action, and latency (MVP 01) forbids a request/response envelope. Mirror, when it returns, is a client-side fan-out of `input.*`, not a target on the wire.

## 2. Studio: one component per verb

- One `ActionDialog` family: `RunDialog`, `InstallDialog`, `TransferDialog`, `NetworkDialog`, `LabelDialog`, `PrepareDialog`, `CutoverDialog`, `ForgetDialog`, `AdbDialog`. Each takes a `target` prop and nothing else about where it was opened from.
- One `DevicePicker` and one `useTarget` hook, specified in §2.1.
- Entry points open the same dialog with the target pre-filled: device header (one id), device popup (one id), wall context menu (one id), wall bulk toolbar (selection), cluster chip (clusterId), Jobs page "Run again" (the batch's target).
- One outcome renderer: a per-device result list used by every dialog and by the operation tray.

### 2.1 The device picker (CEO, 2026-09-03)

The picker is the **first row of every action modal and popup**, always, in the same place, above the verb's own fields. It is not a step before the action; it is part of the action.

- **Pre-filled from context.** Opened from one device, it shows that one device selected. Opened from a wall selection, it shows the selection. Opened from a cluster chip, it shows the cluster with its resolved member count. Opened from the Jobs page "Run again", it shows the batch's original target.
- **Always editable in place.** The user can add or remove devices, switch the mode to a cluster or tags, or clear and search, without closing the modal or losing the fields below. Changing the target never resets the verb's parameters.
- **Three modes, one control:** devices (chips with search over label, number, tag, cluster), cluster (one select), tags (multi-select). The mode is a segmented control inside the picker row; the current mode's summary is the collapsed state ("3 devices", "Cluster A · 12 devices", "tag:warm · 7 devices").
- **Shows readiness before the click.** Each selected device carries its current activities (MVP 04) as a small marker in the chip: running a job, installing, offline. After the first request, `warned` and `forbidden` sentences render inline on the same chips, and the primary button becomes "Continue for N devices" or is disabled when every device is forbidden.
- **Single-device verbs use the same row.** A verb that only makes sense on one device (none in the MVP list, but plugins may declare `maxTargets: 1`) still renders the picker, locked to one chip and switchable to a different device, so the layout never changes from modal to modal.
- **One component, one hook, one place.** `components/target/DevicePicker.tsx` plus `useTarget`; every `*Dialog` in §2 composes it at the top. The picker owns target state; the dialog owns verb fields; the submit merges the two into the §1.1 body.

**Visual contract (CEO, 2026-09-03).** Today the picker sits at the top of some dialogs, at the bottom of others, and sometimes under a line of explanatory text, so it reads as one more form field. The rule from now on:

- The picker is its **own container**, visually distinct from the form: its own surface colour and border, full width, flush under the modal title, with nothing between the title and the picker. No helper text, no description, no section heading above it.
- The form for the verb starts **below a clear divider** in a separate container. The two never share a background or a border.
- The picker's collapsed state is a single line ("3 devices", "Cluster A · 12 devices"); expanding it grows the picker container, never the form.
- The same container, at the same position, with the same height when collapsed, in every action modal and popup. A dialog that needs no target (settings, editors) simply has no picker; it never has the picker somewhere else.
- The exact tokens, spacing, and chip design come from the CEO's new UI design (to be discussed) and are recorded in `docs/design.md`, not here. This section fixes position and separation only.

## 3. Removed

- Routes: every `/:id/<verb>` action route listed in §0, `/devices/network/apply`, `/devices/labels/apply`, `/devices/prep/apply`, `POST /api/jobs` as a public enqueue (kept internal for the workflow orchestrator, MVP 05), `POST /api/transfers` split by device.
- Studio: `InstallBatchDialog`, `BulkTransferDialog`, `BulkPrepDialog`, `BulkForgetDialog`, `BulkCutoverDialog`, `BulkProxyDialog`, `components/command/TargetPicker.tsx`, `target-preview.ts`, `AdbCommandDialog` (folded into `AdbDialog`), and the job-or-batch branch in `RunScriptDialog`.
- Protocol: the per-verb response schemas replaced by one `ActionResponseSchema`.

## 4. Cost

A new `api/actions.ts` router that dispatches verbs to the existing per-device implementations (the device-side code is unchanged: install, push, wake, network apply already work one device at a time). Roughly one sprint core, one sprint Studio, and the deletion list above. The SDK and MCP capability surface follows the same shape, so scripts and agents get the target convention for free.

## 5. Open points

1. Verb naming: `POST /api/actions/<verb>` (proposed) versus `POST /api/devices/actions/<verb>`. Proposed the former, because plugins add verbs that are not device actions.
2. Whether `sleep`/`wake` stay as readiness writes (`PUT /:id/readiness`) or become verbs. Proposed: verbs, so the wall's bulk "Wake" and the device header's "Wake" are the same call.
