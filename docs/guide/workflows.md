# Workflows

A workflow is a pipeline of scripts that runs as **one job, on one device, under one lease** — nothing else can use that device between nodes, and the app state one node leaves behind is what the next one starts from. The full design is `docs/plans/99-m64-workflows.md`; the document shape and the two closed grammars a node can use are `packages/protocol/README.md`; the executor, `job_nodes`, and resume are `packages/core/README.md`. This page is the owner's own example, built end to end.

## The example

> *Scroll FYP (warm up) → Search Keywords & Scroll → Scroll FYP again → Report.*

Four nodes, one gate, one workflow parameter:

1. **`scroll1`** — `tiktok/auto-scroll@1.4.0`, warms up the feed. `starts from: a clean device` (it is the first node, so it gets the farm's default reset).
2. **`search1`** — `tiktok/searched-follow@1.4.0`, searches for a keyword and scrolls the results. `starts from: where node 1 finished` — the default for every node after the first, and the entire point of a pipeline: the app is still open and on the feed when this node begins, not freshly relaunched.
3. **`enough`** (a gate) — checks whether node 1 actually found enough videos to make searching worthwhile: `scroll1.videos >= 10 → continue`, otherwise `stop`. The workflow ends **successfully** on `stop` — a gate stopping is not a failure, it is the pipeline deciding there is nothing more useful to do.
4. **`scroll2`** — `tiktok/auto-scroll@1.4.0` again, a second warm-up pass.
5. **`report1`** — `tiktok/report@1.0.0`, reads `{ run: 'summary' }` — every completed node's own output — and produces a summary.

One workflow parameter, `keyword`, bound into node 2's `keyword` param with `{ param: 'keyword' }`. Without it the search term would be frozen into the document and the workflow would be usable exactly once.

## Building it

In Studio: **Workflows → New workflow**. Add nodes in order; each row gets a script + version picker (the same one the run dialog already uses), a bindings sub-form per parameter, and a plain-language `starts from:` line — never a hidden toggle labelled "reset". For node 2's `keyword` parameter, click **Promote** instead of typing a constant: it lifts the parameter to the workflow's own level, copying its title, description, and hints verbatim from the node script's own `paramsSchema` — one click, and the workflow's run form is the script run form. Add the gate before the Report node using the predicate editor (the one hand-built control in the whole editor — every operator is reachable from a dropdown, never typed as JSON).

Press **Validate** before publishing. It runs the exact same check the publish route runs, so nothing it approves can later be refused at publish for a different reason. Expect to see `W_WORKFLOW_LATEST_REF` warnings if any node names `@latest` rather than a pinned version — legal, and worth knowing about, because it means the workflow's behaviour can change without the workflow itself changing. Every finding is shown at once, not one at a time: fixing one error and re-validating should not surface a second error the tool already knew about.

## Running it

From the run dialog, the **Workflow | Script** filter above the picker switches to workflows; choosing one loads its generated parameter form exactly like a script's. The consequence sentence gives an upper bound, never a plain estimate — *"4 nodes, up to about 42 min per device"* — because it is the sum of the nodes' own declared timeouts, and "about" alone would imply a number the workflow might exceed without warning.

While it runs, the device page and the job detail's **node timeline** show live progress: which node is running (`node 2/4`), and — after it finishes — one row per node execution with its status, duration, attempts, and, for the gate, the resolved sentence: `enough — scroll1.videos (12) >= 10 → continue`. Nothing about why a gate branched the way it did requires opening the log.

## What resume does and does not promise

If a node fails, its own retries run first — same job, same device, same lease. If it still fails and the pipeline stops, the failed node's job detail page offers **Resume from here**.

**Resume is never automatic, and it is always a new job.** Once the original job ended, the device returned to `idle` and the farm may have done anything with it in the meantime — nobody can vouch for its state. So resume:

- creates a **new** job, never restarts the old one;
- copies the version the original job actually ran (never `@latest` re-resolved — a pipeline resumed a week later runs the exact code it started with, even if a newer version has since been published);
- carries forward every earlier node's recorded output, so a binding at node 5 still resolves from node 1's result;
- still runs the **pre-job reset** on its very first execution in the new job — resume does not assume the device is where the original pipeline left it, because it might not be;
- marks every node before the resume point `skipped-on-resume` in the new job's own history — a different status, rendered differently, from a node that was `skipped` because a gate branched away from it. One means "this genuinely ran and we are trusting its recorded output"; the other means "the cursor never reached this node at all."

The dialog names every node that will not run again before you confirm. **Re-running the whole workflow from the start is the one-click, always-safe default** — resume is the informed choice for when you know skipping those nodes' side effects again is fine, and it is never available to a schedule for exactly that reason: an unattended caller cannot make that judgement call.

## What is deliberately not here

- **No expression language.** A gate compares values it already has, using a closed set of operators (`gte`, `contains`, `isEmpty`, and eleven more) — never author-supplied code, never a regular expression. If a decision needs arithmetic or a computation the operator set cannot express, write a script node that returns a verdict and gate on its output; that script inherits full crash containment, versioning, and its own parameter form for free.
- **No parallel nodes.** One device, one session, one node running at a time — a workflow's whole value is holding the device through a sequence, and there is no second device for anything to run alongside.
- **No nested workflows.** A node's script must be an ordinary script, never another workflow.
