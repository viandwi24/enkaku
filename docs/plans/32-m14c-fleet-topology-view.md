# Plan 32 — M14c : Fleet Topology View

> Status: implemented (2026-08-02) — viewer count on tiles deliberately omitted, see the report note in §9
> Ships: packages/core/src/api/topology.ts
> Depends on: Plans 19–21 complete (tags, clusters, batches). Best built after Plan 31 so a device tile can show who is watching it.
> Spec references: §7.5 (device identity), §10.1 (device states), §16 (NFR), `docs/design.md`.

---

## 1. Goals

- One screen shows the whole farm at once: every device, how it is grouped, and what state it is in.
- The state that matters at a glance — online/busy/manual/quarantined, battery, temperature, current job — is readable without hovering or clicking.
- Clusters are visible as groupings, including the fact that one device can sit in several of them.
- A device tile is a route into the thing you actually want: its control page, its logs, its jobs.
- It stays usable at 5 devices and at 200.

## 2. Non-goals

- A physical rack diagram or drag-to-arrange layout. Position carries no meaning here; state and grouping do.
- Editing from this screen. It is a map, not a control panel. Clicking navigates.
- A graph library. See §3.3.
- Historical playback. Live state only.

## 3. Context and design decisions

### 3.1 Why the devices list is not enough

The devices list answers "which devices exist". It cannot answer the questions a farm operator actually has: *is anything overheating, is this cluster fully busy, which phones are idle right now, is that batch spread across the machines I think it is.* Those are shape questions, and a table is the wrong shape for them.

### 3.2 Clusters overlap, so this is not a tree

A device can belong to several clusters — this was confirmed as the intended model (Plan 19 §9.3, decided 2026-08-02). A strict tree would therefore have to duplicate devices or lie.

The layout is **grouped tiles, not a graph**: one section per cluster, each containing the device tiles that resolve into it, and a device appears in every section it matches. A closing section lists devices in no cluster at all — which is itself information worth seeing.

Duplication across sections is honest here: it *is* the fact being displayed. A device tile shows a small badge with its total cluster count so the repeat is never mistaken for a data error.

### 3.3 No graph library

A force-directed graph is the obvious reach and the wrong one: node-link diagrams are hard to read, terrible on narrow screens, animate for no reason, and the relationship here is set membership rather than topology. The design system already has cards, badges, and the LED state colours (`docs/design.md`); grouped tiles built from those cost no new dependency, stay responsive, and match every other screen.

This also keeps the artifact self-contained — no CDN, consistent with how the rest of Studio is built.

### 3.4 What a tile shows

Density is the whole point, so each tile carries only what is scannable:

- **Status** as the dominant signal — the LED colour already used by `DeviceStatusBadge`.
- Label and `stableId` — two phones share a model name, so the identity has to be there (spec §7.5).
- Battery and temperature, with temperature switching to the warning colour at the auto-quarantine threshold rather than at an arbitrary number.
- The current job, when busy — the thing you want to know before touching anything.
- Viewer count, once Plan 31 lands. Knowing someone is already driving a phone before you open it is the point.

### 3.5 Live, and cheap

The screen subscribes to what already exists — `device.status`, `device.battery`, `job.status`, `batch.status` — and updates tiles in place. It fetches once on load and never polls. A farm of 200 devices means 200 tiles reacting to sparse events, which is well within budget.

Temperature and battery arrive through `device.battery`, which the core already broadcasts (Plan 17 wired the device page to it).

### 3.6 Scale

At 200 devices the grid gets long. Three affordances, no virtualisation:

- Filter by tag, reusing the Plan 19 filter bar.
- Collapse a cluster section to a single summary row (`8 devices · 6 idle · 2 busy`).
- A compact mode that drops to status + label only.

## 4. Technical design

### 4.1 Data

No new tables. One endpoint assembles what is already stored:

```
GET /api/topology
→ {
    clusters: { id, name, deviceIds: string[] }[],
    devices: DeviceInfo[],           // includes tags (Plan 19)
    ungroupedDeviceIds: string[],
    activeJobs: { deviceId, jobId, scriptName, startedAt }[],
  }
```

Cluster membership is resolved with the existing `resolveTarget` from `packages/core/src/clusters/resolve.ts` — reused, not reimplemented, so the map can never disagree with what a batch would actually target.

One request rather than the client joining four endpoints: the join needs cluster resolution, which is server-side logic.

### 4.2 Studio

`packages/studio/src/app/topology/page.tsx`, plus:

- `components/topology/DeviceTile.tsx` — the tile from §3.4.
- `components/topology/ClusterSection.tsx` — header (name, counts, collapse) and the tile grid.

Sidebar entry: **Topology**, under Devices.

State: one fetch on mount, then in-place updates from the WS events in §3.5. Reuses `useNow` (Plan 17) for the "running for 2m" on busy tiles.

Responsive: CSS grid with `auto-fill, minmax(200px, 1fr)`. One column on a phone, no horizontal scroll — the quality floor in `docs/design.md` applies here like everywhere else.

### 4.3 Empty states

Three distinct ones, because they mean different things and a single "nothing here" would be useless:

- No devices at all → point at enrolment.
- Devices but no clusters → show the ungrouped section and explain what a cluster buys.
- A cluster resolving to zero devices → say so on the section, since a cluster whose tags match nothing is a real misconfiguration worth surfacing.

## 5. Implementation steps

### 32.1 Endpoint
- [ ] `packages/core/src/api/topology.ts` per §4.1, reusing `resolveTarget`.
- [ ] Unit test: a device in two clusters appears in both `deviceIds` lists; a device in none appears in `ungroupedDeviceIds`; the two sets together cover every device exactly once.
- Result: `curl 127.0.0.1:7700/api/topology | jq` returns the whole farm in one call.

### 32.2 Tile and section
- [ ] `DeviceTile.tsx` with the §3.4 fields and the design-system LED colours.
- [ ] `ClusterSection.tsx` with counts and collapse.
- Result: both render from fixture data with no network.

### 32.3 Screen
- [ ] `app/topology/page.tsx`: fetch, group, render, sidebar entry.
- [ ] Tag filter, compact mode, the three empty states.
- Result: the page shows every device grouped, at 1 and at 200 devices.

### 32.4 Live updates
- [ ] Subscribe to `device.status`, `device.battery`, `job.status`, `batch.status`; update tiles in place.
- Result: plugging a device in, or starting a batch, changes the map with no reload.

### 32.5 Polish
- [ ] Keyboard navigable tiles, visible focus, `prefers-reduced-motion` respected.
- [ ] Verify at 320 px width: one column, nothing clipped, no horizontal scroll.
- Result: meets the `docs/design.md` quality floor.

## 6. Acceptance criteria

1. `/topology` shows every enrolled device, grouped by cluster, with an ungrouped section.
2. A device in two clusters appears in both, and its tile states how many clusters it belongs to.
3. A tile shows status, label, stableId, battery, temperature, and the running job when busy.
4. Temperature turns warning-coloured at the auto-quarantine threshold, not at a hardcoded number.
5. Plugging in, unplugging, or starting a job updates the map live with no reload.
6. Filtering by tag narrows the map; collapsing a cluster leaves a summary row.
7. A cluster matching no devices says so rather than rendering an empty box.
8. Usable at 320 px: one column, no horizontal scroll.
9. `bash scripts/typecheck.sh`, `bun test`, and `bun run build:studio` are green.

## 7. Test plan

**Unit**
- `packages/core/src/api/topology.test.ts` — overlap, ungrouped, full coverage of the device set, and a cluster resolving to nothing.

**Manual smoke** (two devices)

```bash
bun run dev
curl -s 127.0.0.1:7700/api/topology | jq '{clusters: [.clusters[].name], ungrouped: (.ungroupedDeviceIds|length)}'
# open /topology
#   tag one device into a second cluster → it appears in both sections
#   start a job → that tile flips to busy and names the script
#   unplug a device → its tile goes offline within ~2 s
#   narrow the window to 320 px → single column, no clipping
```

## 8. Risks and mitigations

| Risk | Mitigation |
|---|---|
| The map disagrees with what a batch actually targets. | Both use `resolveTarget`. Reuse is the mitigation; reimplementing the resolution would be the bug. |
| A device duplicated across sections reads as a data error. | A cluster-count badge on the tile makes the repeat explicit and expected. |
| 200 tiles re-render on every battery event. | Update tiles in place, keyed by device id; a battery event touches one tile. |
| Feature creep into a control surface. | Non-goal §2: the map navigates, it does not act. |

## 9. Open questions

1. Should the map show agent-owned (cloud) devices differently from local ones? Proposed: yes, a small badge — where a device lives affects latency and who can reach it.
2. Is a per-cluster "run a script here" shortcut worth breaking the read-only rule for? Proposed: no; it belongs on the cluster page.
3. Should ungrouped devices be a section or a separate screen? Proposed: a section, so nothing hides.
4. Does this replace the devices list, or sit beside it? Proposed: beside it. Tables are better for sorting and bulk selection; the map is better for shape.
