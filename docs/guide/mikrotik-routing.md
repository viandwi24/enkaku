# MikroTik routing — steering a device out a chosen link

The `mikrotik-routing` plugin assigns each farm device its own internet egress path by writing
**policy routing rules on a MikroTik router**, so an operator stops hand-editing router config
every time a device should move to a different link.

**It never touches the device.** The only thing that changes is the router.

---

## What it does, and what it deliberately does not

The plugin writes to exactly **one** router endpoint — `/routing/rule` — and reads everything
else. That is the smallest possible blast radius, and it is what makes the ownership marker
below sufficient as a safety boundary.

| | Endpoint | Purpose |
|---|---|---|
| **Write** | `/routing/rule` | **Only this.** The device → path rules: create, re-point, delete |
| Read | `/routing/table` | The egress paths a device can be assigned to |
| Read | `/ip/route` | Which path is up — a path is up iff its default route carries the `active` flag |
| Read | `/ip/dhcp-server/lease` | Whether a device's address is a static or dynamic lease |
| Read | `/interface` | Inventory context |

It does **not** configure the router's links themselves — no VLANs, no DHCP, no NAT, and none of
the routing tables it steers into. Those are built once by an operator; the plugin reads them and
refuses to invent them.

Every rule it writes carries a structured comment:

```
enkaku:mikrotik-routing:v1:<groupId>:<endpointKey>
```

The plugin creates, patches and deletes **only** rules whose comment starts with
`enkaku:mikrotik-routing:`. Everything else on the router is read-only to it, shown in the Rules
tab as **foreign**, and never modified — including rules you wrote by hand, and including rules
from other Enkaku packs.

---

## The one prerequisite you must add by hand

**Read this before assigning anything. The plugin refuses to apply until it is satisfied, and the
refusal is the whole reason this section exists.**

Policy routing rules match on a packet's **source address** and send it into a routing table.
When the plugin assigns a device to a path, it writes:

```
/routing rule add src-address=<device> action=lookup-only-in-table table=<path>
```

`src-address` matches **every packet the device sends** — regardless of destination. And
`lookup-only-in-table` means: resolve the destination **only** in that table, which contains a
default route and nothing else.

So the device's traffic **back to the controller** — the ADB reply on 5555, the Studio session,
the scrcpy stream — is dragged into the egress table too, and sent out of the link instead of
back across the LAN. The link has no route to a private LAN address, so the packet dies there:

```
device ──▶ reply to the controller
              │
              ▼   rule: everything from this device → the egress table
        egress table holds only "default via <link>"
              │
              ▼
        reply leaves via the link, never reaches the controller  ✗
```

The controller never gets an answer, so **ADB drops and the device becomes unreachable from
Enkaku** until the rule is removed by hand. Assign a whole fleet without this in place and you
lose the whole fleet at once.

The fix is one rule, sitting **above** every device rule, that sends local-destined traffic back
through the ordinary table:

```
/routing rule add src-address=<device-subnet> dst-address=<local-ranges> \
    action=lookup table=main comment="farm: local exception"
/routing rule move [find comment="farm: local exception"] destination=0
```

**Why the plugin cannot write this for you:** routing rules are evaluated top-down, this one must
be first, and RouterOS's REST API has no way to position a rule. The plugin can only check for it
— which it does, and blocks on.

### Adding it

Open a terminal on the router (WinBox → **New Terminal**, or SSH) and paste both lines. Then
confirm with `/routing rule print` that it is at position **0**. The Settings tab shows the exact
two commands for your own topology — the device subnet is derived from the devices the plugin can
see, and the local range from the address the controller was observed to reach the router from.

Adding it through the REST API only gets you halfway: the `add` works, the `move` has no REST
equivalent.

### The three states the check reports

| State | Meaning | Apply |
|---|---|---|
| `ok` | Every device the plugin knows is protected, by a rule positioned above the device rules | allowed |
| `partial` | A rule exists but leaves some devices uncovered, or sits below the device rules | **blocked**, naming the uncovered devices |
| `missing` | No candidate rule at all | **blocked** |

`partial` is the state most worth understanding, because it is the one that looks safe and is
not. A rule that protects the *controller's* own addresses, for example, does nothing for the
*devices* — the source addresses are different. The check matches on rule behaviour (action,
table, source and destination coverage, position, and whether it is disabled), never on the
comment text, so a correctly-shaped rule you wrote under any name is recognised.

---

## Identity — how a device becomes an address

The router knows LAN addresses; Enkaku knows devices. The plugin owns that bridge, and it assumes
it can be wrong, because **a stale address silently steers the wrong device** and the router
cannot detect it.

Addresses resolve in three tiers, best first:

1. **`transport`** — the device is attached over adb-tcp, so its transport address *is* its LAN
   address. Exact and live, with nothing inferred.
2. **`probe`** — read from the device itself.
3. **`manual`** — typed by an operator, for anything the first two cannot answer. A device with no
   derivable address is listed as needing one, never hidden and never guessed at.

Whichever tier produced it, the address is cross-checked against the router's DHCP leases: a
**dynamic** lease raises a warning, because that address can move to a different phone.

---

## Paths and health

A path is one routing table carrying a default route. A path is **up** only when that route
carries the `active` flag — on a typical farm that flag is maintained by `check-gateway=ping`.

An assignment pointing at a down path is shown in the plan as `skip` and is **not written
silently**: a rule into a dead path is a device with no internet, and that should never be a
surprise.

---

## Plan, then apply

Every change is computed as a diff between the desired state and the router's current managed
rules, and rendered before anything is written:

```
+ create   <device> → <path>              (group)
~ update   <device>   <old> → <new>       (group)
- delete   <device> → <path>              (was group)
! skip     <device> → <path>              path is DOWN
? foreign  <address> → <path>             not managed, untouched
```

Rule ids are never stored: RouterOS ids are not stable across a reboot or a configuration
reload, so every write resolves its target first, by ownership marker and source address. Two
matches for one device is a refusal, not a guess — a duplicate means something already went
wrong, and picking one would hide it.

---

## Security

- Router credentials are stored as a secret and are **never readable back** from the plugin's own
  screen. Re-enter them to change them.
- The router-side API user should be scoped with `address=` to the controller's own subnet, and
  needs write access to `/routing/rule` only. Read-only everywhere else.
- Plain HTTP is acceptable only on a trusted management segment. The Settings tab says so rather
  than pretending otherwise; TLS is a toggle.
- The plugin declares no device-control capability at all — it reads the fleet and runs jobs, and
  has no way to touch a phone.

---

## Staying generic

Nothing in the plugin knows any particular site's addressing. The data model is *device → egress
path*, never *device → modem*: a path is a routing table, which on one farm happens to be an LTE
modem and on another is a second ISP, a VPN egress, or a lab uplink. The vendor-specific half —
the words `src-address`, `lookup-only-in-table`, `/rest/` — is confined to one driver file, so a
second vendor or a different RouterOS transport slots in without touching the rest.
