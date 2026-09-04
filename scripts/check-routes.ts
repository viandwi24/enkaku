#!/usr/bin/env bun
/**
 * The orphan-route rule, as a CI script (plan 213 §3.7, §4.10).
 *
 * It used to be a Studio test on the old, deleted 14-item nav ("no built
 * top-level page is missing from the nav"), written because `/workflows`,
 * `/recordings` and `/topology` were all built, tested and shipped with no
 * way in. Plan 201 deleted every Studio test (plan 200 §8.3) and no MVP
 * plan may write another, so the rule moved here.
 *
 * It checks three things and exits non-zero on any of them:
 *   1. every top-level `src/app` directory holding a `page.tsx` is either in
 *      the rail or in one of the three lists below;
 *   2. every entry in those lists still exists on disk. A stale exemption is
 *      a failure, so the plan that deletes a route must prune its own row and
 *      the list can never rot into a permanent excuse;
 *   3. no route is both in the rail and in a list.
 *
 * DISCREPANCY (plan 213 §11, recorded here too so a later reader is not
 * surprised): the plan's own `PENDING_REMOVAL` assumed plan 207 had already
 * merged into `mvp` before this plan runs (plan 200 §8.1: merge order within
 * a stage follows plan number, and both are in stage/round R3). At the time
 * this script was written, plan 207 was still `draft` — `app/console/` and
 * `app/topology/` still exist, and `app/clusters/` has not been renamed to
 * `app/groups/`. The three lists below reflect the ACTUAL tree (plan 200
 * §2.2: the file wins for facts), with `/clusters`, `/console` and
 * `/topology` added to `PENDING_REMOVAL`, owned by plan 207, and `/groups`
 * removed (it does not exist yet). Once plan 207 lands, its own executor
 * updates this file: delete the `/clusters`/`/console`/`/topology` rows (or
 * whichever of them plan 207 actually disposes of) and, if plan 207 still
 * leaves a dedicated `/groups` route with no nav entry, add that row back
 * for plan 214 to own, exactly as originally drafted.
 *
 * Usage: bun run scripts/check-routes.ts
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dir, '..')
const APP_DIR = join(ROOT, 'packages/studio/src/app')
const NAV_PATH = join(ROOT, 'packages/studio/src/components/shell/nav.ts')

/** Never in the rail, and that is correct. */
const NOT_IN_NAV_BY_DESIGN: Record<string, string> = {
  '/login': 'auth route; AuthGate redirects here, and there is no session to draw a rail for',
  '/setup': 'first run only; AuthGate redirects here',
}

/**
 * Still on disk, no rail entry, and a NAMED later plan deletes it. Every row
 * is a debt with an owner (MVP 03 §1, MVP 13 A.6). Deleting the route without
 * deleting the row fails check 2.
 */
const PENDING_REMOVAL: Record<string, string> = {
  '/groups': 'plan 214: the groups page plan 207 renamed from /clusters goes away once groups are managed from the Devices tab strip (MVP 15 §0.1.3)',
  '/device': 'plan 215: Device Control is the device surface; the device page and its route go (MVP 15 §1)',
  // See the DISCREPANCY note above: plan 207 (not yet merged) renames this to
  // /groups (MVP 13 A.6a); plan 214 then removes the dedicated route
  // entirely once groups live in the Devices tab strip.
  '/nodes': 'plan 214: Nodes becomes a Devices tab, shown only in orchestrator mode (MVP 03 §1.1)',
  '/workflows': 'plan 217: second tab of Scripts & workflows (MVP 03 §1)',
  '/schedules': 'plan 217: third tab of Scripts & workflows (MVP 15 §0.1.1)',
  '/batches': 'plan 218: second tab of Jobs (MVP 15 §1)',
  '/tools': 'plan 219: Toolchain section of Settings (MVP 03 §1.1)',
  '/workspace': 'plan 220: Workspace is renamed Files and lives under Agents (MVP 15 §0.1.2)',
}

/** Parked, not deleted, with no successor plan. */
const DEFERRED: Record<string, string> = {
  '/recordings': 'MVP 15 §0.1.5: recordings are deferred, out of the nav, the code parked behind MVP 06, not deleted',
}

function fail(lines: string[]): never {
  for (const line of lines) console.error(`FAIL: ${line}`)
  process.exit(1)
}

function main(): void {
  if (!existsSync(NAV_PATH)) fail([`missing ${NAV_PATH}`])
  const navSource = readFileSync(NAV_PATH, 'utf8')

  const navHrefs = new Set<string>()
  for (const m of navSource.matchAll(/href: '([^']+)'/g)) navHrefs.add(m[1]!)
  const settingsMatch = navSource.match(/SETTINGS_HREF = '([^']+)'/)
  if (!settingsMatch) fail([`could not find SETTINGS_HREF in ${NAV_PATH}`])
  navHrefs.add(settingsMatch[1]!)

  if (!existsSync(APP_DIR)) fail([`missing ${APP_DIR}`])
  const routes = new Set<string>()
  for (const entry of readdirSync(APP_DIR, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pagePath = join(APP_DIR, entry.name, 'page.tsx')
    if (existsSync(pagePath)) routes.add(`/${entry.name}`)
  }

  const exemptionLists: Array<[string, Record<string, string>]> = [
    ['NOT_IN_NAV_BY_DESIGN', NOT_IN_NAV_BY_DESIGN],
    ['PENDING_REMOVAL', PENDING_REMOVAL],
    ['DEFERRED', DEFERRED],
  ]
  const exemptRoutes = new Set<string>()
  const problems: string[] = []

  // Check 2: every listed exemption still exists on disk.
  for (const [listName, list] of exemptionLists) {
    for (const route of Object.keys(list)) {
      if (exemptRoutes.has(route)) {
        problems.push(`${route} appears in more than one exemption list`)
      }
      exemptRoutes.add(route)
      if (!routes.has(route)) {
        problems.push(`${route} is listed in ${listName} but does not exist (${APP_DIR}${route}/page.tsx) — prune this row`)
      }
    }
  }

  // Check 3: no route both in the rail and in a list.
  for (const route of exemptRoutes) {
    if (navHrefs.has(route)) {
      problems.push(`${route} is both a NAV entry and an exemption — remove it from the exemption list`)
    }
  }

  // Check 1: every route on disk is either in the rail or exempt.
  for (const route of routes) {
    if (!navHrefs.has(route) && !exemptRoutes.has(route)) {
      problems.push(`${route} has a page.tsx but no NAV entry and no exemption — add a nav entry, or list it in PENDING_REMOVAL/DEFERRED with an owning plan`)
    }
  }

  if (problems.length > 0) fail(problems)

  console.log(`routes ok: ${navHrefs.size} in nav, ${exemptRoutes.size} exempt`)
  process.exit(0)
}

main()
