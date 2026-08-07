#!/usr/bin/env bash
# Compare each plan's declared status against whether its code actually exists.
#
# The plan documents are the contract an AI agent builder reads to decide what
# to work on next. When a shipped plan still says `draft`, an agent told to
# "work the plans in order" re-implements finished work; when an unstarted one
# claims to be implemented, it gets skipped. Both happened in this repo — six
# of eight plans checked by hand were shipped while still marked draft — so
# the drift is not hypothetical and no one notices it by reading.
#
# A plan opts in by declaring the artefact that proves it shipped:
#
#   > Status: implemented — ...
#   > Ships: packages/core/src/events/recorder.ts
#
# Plans with no `Ships:` line are skipped and counted, not guessed at.
#
# A second rule catches a narrower, sneakier failure than "the artefact is
# missing": a plan whose `Ships:` artefact genuinely exists, and whose own
# `> Status:` header nonetheless admits — in its own prose, usually a
# deviations or "Not done" note — that it did not build something it
# declared. Three plans in this series (79, 81, 82) did exactly this: real
# code shipped, status said `implemented`, and a Studio surface the plan's
# own implementation steps named was quietly skipped. See the
# `ADMISSION_REGEX` comment below for the exact rule and its reasoning.
#
# Exits non-zero when anything disagrees, so it can gate a release.
set -uo pipefail
cd "$(dirname "$0")/.."

mismatch=0
skipped=0
partial=0
admits_unbuilt=0

# Second rule: a plan may not claim `implemented` while its OWN `> Status:`
# header admits it did not build something it declared. This is not guessed
# at from the code — the exists/not-exists check above already does that —
# it is read straight from the prose the agent that wrote the header left
# behind. Plan 81 shipped exactly this: status `implemented`, plus its own
# deviation (4) saying Studio "was not built". The exists check could not
# catch it because the plan's `Ships:` artefact (a core file) genuinely
# exists; only the header's own words say the plan is incomplete.
#
# Phrases below were harvested from real slip-ups this series produced
# (plans 79, 81, 82 each shipped Studio-shaped work undone and still said
# `implemented`), not invented up front — so this is a narrow, evidenced
# list, not a guess at every way an agent might hedge.
#
# `skipped` is deliberately NARROWED to its passive form (`was skipped` /
# `were skipped`) rather than the bare word: a first pass against every
# `implemented` plan in this repo found bare `skipped` firing on plans 67
# and 73 describing a BUG already fixed in the same sentence ("early-return
# ... skipped cascading to its descendants", "migrations ... were silently
# skipped while 0036 ... was not [skipped]") — past-tense narration of what
# went wrong and was corrected, not an admission of present incompleteness.
# The passive "was/were skipped" idiom did not appear in any status line at
# all at the time of writing, so narrowing to it trades a phrase that never
# actually caught anything real for one that stops catching bug narration.
ADMISSION_REGEX='(was not built|were not built|not built|not done|scope cut|cut for scope|was skipped|were skipped)'

for plan in docs/plans/*.md; do
  ships=$(grep -m1 '^> Ships: ' "$plan" | sed 's/^> Ships: //' | tr -d '\r')
  if [ -z "$ships" ]; then
    skipped=$((skipped + 1))
    continue
  fi

  status=$(grep -m1 '^> Status: ' "$plan" | sed 's/^> Status: //' | tr -d '\r')

  # `partial` is a third state, not a broken second one. A plan that shipped
  # half of itself has an artefact on disk AND unfinished work, so neither
  # "implemented" nor "draft" is true and the exists/not-exists test below
  # cannot say anything useful about it. Counting these separately keeps the
  # honest answer available instead of pushing authors toward rounding a
  # partial up to `implemented` (or down to `draft`) just to get a green run.
  case "$status" in
    partial*)
      partial=$((partial + 1))
      printf '  PARTIAL  %-46s %s\n' "$(basename "$plan")" "${status:0:52}"
      continue
      ;;
  esac

  claims_shipped=false
  case "$status" in
    implemented*) claims_shipped=true ;;
  esac

  # Only a plan CLAIMING `implemented` can be caught admitting it is not —
  # a `draft` header saying it left something out is simply describing its
  # own honest state, not contradicting it.
  if [ "$claims_shipped" = true ]; then
    # This repo already has a convention for disclosing a deliberate,
    # reasoned exclusion: a trailing `**Not done...:** ...` heading (see
    # plans 67, 73, 76, 77, 78 — the words after "Not done" vary: "in this
    # pass", ", recorded rather than silently dropped", etc., so the match
    # below allows anything up to the closing `**`) — a plan explicitly
    # separates "here is what I chose not to build, and why" from the rest
    # of its completion claim. That heading is the one thing this check
    # trusts as a genuine non-goal: everything from its FIRST occurrence to
    # the end of the status line is exempted before the phrase search below
    # runs, so a reasoned "Not done: X, because Y already covers it" is
    # never flagged. A bare admission with no such heading — plan 81's
    # "(4) ... was not built" inside its "Deviations" list, with no
    # substitute and no heading — gets no such pass: a "Deviations" list is
    # where this series ALSO buried the unbuilt Studio panels, so that
    # heading alone is deliberately NOT treated as a safe harbor the way
    # `Not done:` is.
    #
    # A second, narrower exemption: "is the operator's and is not done" is
    # this repo's own recurring idiom (verbatim, in plans 57, 59, 60) for a
    # verification step that requires a human at real hardware — an agent
    # cannot do it BY CONSTRUCTION, which is a different fact from "this was
    # declared and left unbuilt". Only that exact clause is removed, not
    # truncated to end-of-line like the heading above, so a genuine
    # admission appearing later in the same status line is still caught.
    checkable=$(
      printf '%s' "$status" \
        | sed -E 's/\*\*[Nn]ot [Dd]one[^*]*\*\*.*$//I' \
        | sed -E "s/is the operator.s and is not done//Ig"
    )
    admission=$(printf '%s' "$checkable" | grep -oiE "$ADMISSION_REGEX" | head -1)
    if [ -n "$admission" ]; then
      admits_unbuilt=$((admits_unbuilt + 1))
      printf '  UNBUILT  %-46s claims implemented but admits "%s"\n' "$(basename "$plan")" "$admission"
    fi
  fi

  if [ -e "$ships" ]; then exists=true; else exists=false; fi

  if [ "$claims_shipped" != "$exists" ]; then
    mismatch=$((mismatch + 1))
    if [ "$exists" = true ]; then
      printf '  MISMATCH %-46s says "%s" but %s exists\n' "$(basename "$plan")" "${status:0:24}" "$ships"
    else
      printf '  MISMATCH %-46s claims implemented but %s is missing\n' "$(basename "$plan")" "$ships"
    fi
  fi
done

total=$(ls docs/plans/*.md | wc -l | tr -d ' ')
checked=$((total - skipped - partial))
echo "  checked $checked of $total plans ($skipped declare no Ships: artefact, $partial are partial)"

fail=0
if [ "$mismatch" -gt 0 ]; then
  echo "  $mismatch plan(s) disagree with the code — fix the status line or the code"
  fail=1
fi
if [ "$admits_unbuilt" -gt 0 ]; then
  echo "  $admits_unbuilt plan(s) claim implemented but admit unbuilt work in their own header — mark them partial, or finish the work"
  fail=1
fi
if [ "$fail" -gt 0 ]; then
  exit 1
fi
echo "  every plan that declares an artefact agrees with the code"
