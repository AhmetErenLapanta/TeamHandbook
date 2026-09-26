// The grader's own test set: pairs a human decided the answer to, so the grader's
// agreement is a number before any of its verdicts are believed.
//
// Every item in GRADER_CASES is a REAL output of a run of this package, copied verbatim, not
// an invented one - an invented item is written by the person who also writes the rubric and
// agrees with it by construction. Half the pairs are NO, and the NO half is deliberately hard:
// the same subject as the reference lesson but a different rule, or a real item from one
// session paired with a real label from another.
//
// DISTRACTOR_CONTROLS at the bottom of this file is the one exception and says so in its own
// comment: those items are synthetic on purpose, because the thing they have to contain is
// something a real harvest never produced.
//
// They are run through the exact production call `run.ts` uses, three times each, and the
// report carries the agreement count. If the rubric was edited after reading these, the
// report says so - a rubric tuned on its own test set has not been measured against
// anything.
import type { HarvestItem } from "../../src/lib/harvest.js";
import type { Label } from "./corpus.js";

export interface GraderCase {
  id: string;
  /** what a human says the verdict is */
  expected: boolean;
  /** why, in one line, so a disagreement can be argued with rather than only counted */
  because: string;
  item: HarvestItem;
  label: Label;
}

export const GRADER_CASES: GraderCase[] = [
  {
    id: "clock-is-the-clock-lesson",
    expected: true,
    because:
      "the same rule in its own words: do not touch the global clock, inject a time source, pass the instant the assertion is about",
    item: {
      "kind": "correction",
      "name": "no-global-clock-patching-in-tests",
      "description": "Use when writing or reviewing tests for time-dependent code; never patch/mock the global clock, inject a time source instead.",
      "body": "## Rule\nDo not patch or freeze the global clock (e.g. `Date.now`, a global timer) in tests.\n\n## Why\nPatching the global clock leaks state across tests and makes results depend on run order (a test can pass alone but fail when the suite runs twice or in a different order).\n\n## Instead\n- Design the code under test to accept a time source as a parameter/dependency.\n- In the test, pass the exact instant the assertion is about.\n- If you find yourself reaching for a global clock mock, treat it as a signal that the code under test is reading time from a place it shouldn't (a global/ambient source instead of an injected one).\n\n## Verification\nRun the full test suite at least twice in a row (or in randomized order) and confirm results don't change.",
      "expect": "Time-dependent tests inject an explicit time source instead of mocking a global clock, and the suite passes identically across repeated/reordered runs.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 8,
      "quote": "Right, and that is the part I want changed, not worked around. We do not patch the global clock in tests here, ever. The thing under test takes a time source as an argument, and the test hands it the exact instant it is making a claim about. If you find yourself reaching for the global clock it means the code is reading the time somewhere it should not."
    },
    label: {
            id: "clock",
            anchor:
              "We do not patch the global clock in tests here, ever.",
            kind: "correction",
            lesson:
              "Tests must not replace the system clock; the code takes a time source as a dependency and the test passes in the instant it wants to assert about.",
            concepts: ["test", "clock or time", "inject a time source", "do not patch the global clock"],
            domain: "time-in-tests",
            position: "middle",
            form: "hard-never",
          },
  },
  {
    id: "poll-is-the-poll-lesson",
    expected: true,
    because:
      "states the prohibition, the replacement and the deadline, and even carries the reason the reference gives",
    item: {
      "kind": "correction",
      "name": "poll-dont-sleep-in-tests",
      "description": "Use when a test needs to wait for an async condition (a message being handled, a state change, a background job finishing) before asserting.",
      "body": "## Rule\nNever use a fixed-duration sleep in a test to wait for something to happen asynchronously.\n\n## Why\nA fixed sleep is either wasted time (fast machine) or still not long enough (loaded machine), so bumping the duration just relocates the flake instead of fixing it.\n\n## What to do instead\n- Poll for the actual condition you are waiting on (e.g. a counter, a flag, a call count) at a short interval.\n- Put a deadline on the whole wait, not on individual polls.\n- Make the timeout failure message state which condition never became true, so a future failure is diagnosable immediately.",
      "expect": "Test waits use a poll-with-deadline helper (or equivalent) instead of a fixed sleep, and the timeout failure message names the condition that didn't become true.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 8,
      "quote": "No. We never sleep a fixed amount in a test to let something catch up. Poll for the thing you are actually waiting for and give the poll a deadline. A sleep is wasted time on a fast machine and still too short on a loaded one, so raising it just moves the flake somewhere you will not look for a month."
    },
    label: {
            id: "poll-not-sleep",
            anchor:
              "We never sleep a fixed amount in a test to let something catch up.",
            kind: "correction",
            lesson:
              "A test never sleeps a fixed interval to let something finish; it polls the condition it is waiting for until a deadline, so it is neither slow on a fast machine nor flaky on a loaded one.",
            concepts: [
              "do not sleep a fixed interval",
              "poll for the condition",
              "with a deadline",
              "sleeping is slow when fast and flaky when loaded",
            ],
            domain: "test-synchronisation",
            position: "middle",
            form: "hard-never",
          },
  },
  {
    id: "utc-is-the-utc-lesson",
    expected: true,
    because:
      "the developer taught this in their own language and the item states it in English without losing a part of it",
    item: {
      "kind": "correction",
      "name": "store-timestamps-utc-only",
      "description": "Use when writing or reading date/time values to/from a database or between services.",
      "body": "## Rule\nAlways store and pass timestamps as UTC instants (e.g. a `timestamptz`/instant type), never pre-converted to a local zone.\n\n## Why\nA local-time value loses its offset once written. On read you can't know which offset it was written with, and during DST transitions the same local clock time maps to two different real instants, causing off-by-one-hour bugs.\n\n## How\n- Convert to local time only at the display/UI layer, using the viewer's zone.\n- Keep the storage column and any inter-service payloads as UTC instants.\n- Add a regression test that stores an instant during a DST transition and asserts it reads back identical.",
      "expect": "Timestamp columns use an instant/UTC type (e.g. timestamptz), local-time conversion happens only in the view layer, and a DST-transition round-trip test exists and passes.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 7,
      "quote": "Veritabanına asla yerel saat yazmayız. Her an UTC olarak saklanır ve UTC olarak dolaşır; yerel saate çevirmek yalnızca ekranda, gösterildiği yerde olur. Yerel saat yazılan bir kolonu geri okurken hangi ofsetle yazıldığını bilemezsin, yaz saati geçişinde aynı değer iki farklı ana denk gelir."
    },
    label: {
            id: "utc-storage",
            anchor:
              "Veritabanına asla yerel saat yazmayız.",
            kind: "correction",
            lesson:
              "An instant is stored and passed around in UTC and converted to a local zone only where it is displayed; a local time written into storage cannot be read back unambiguously.",
            concepts: [
              "store in UTC",
              "convert only at the display edge",
              "a local time in storage is ambiguous",
              "the zone belongs to presentation",
            ],
            domain: "time-zone-storage",
            position: "middle",
            form: "hard-never",
          },
  },
  {
    id: "release-order-is-the-release-procedure",
    expected: true,
    because:
      "a procedure label answered by an item the model filed as a correction: the kinds differ, the lesson does not, and recall is about the lesson",
    item: {
      "kind": "correction",
      "name": "release-order-changelog-build-version-tag",
      "description": "Use when cutting a release for any versioned project.",
      "body": "## Release order\nRelease steps must happen in this exact sequence, end to end:\n1. Add the changelog/entry describing what changed.\n2. Rebuild the build output and check it against source so nothing stale is committed.\n3. Bump the version.\n4. Create the tag last.\n\nThe tag must always name a tree someone can actually install (built, documented, versioned).",
      "expect": "When cutting a release, the changelog entry and a verified rebuild land in the commit before the version bump, and the tag is created only after the version bump, pointing at a tree with fresh build output.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 8,
      "quote": "Right, and the order matters end to end: the entry describing the change goes in, then the output is rebuilt and checked against the source so nothing stale is committed, then the version goes up, and the tag comes last. Do it that way every time and the tag always names a tree someone can install."
    },
    label: {
            id: "release-steps",
            anchor:
              "the entry describing the change goes in, then the output is rebuilt",
            kind: "procedure",
            lesson:
              "A release is cut in a fixed order: write the entry describing what changed, rebuild the committed output and confirm it matches the source, raise the version, and only then tag, so the tag always names a tree whose generated files are current.",
            concepts: [
              "write the changelog entry",
              "rebuild and confirm the committed output matches",
              "raise the version",
              "tag last",
            ],
            domain: "release-mechanics",
            position: "closing",
            form: "soft-henceforth",
          },
  },
  {
    id: "lock-timeout-is-the-lock-timeout-lesson",
    expected: true,
    because:
      "an error-fix label answered by an item the model filed as a discovery, carrying the short timeout, the batching and the fail-fast reason",
    item: {
      "kind": "discovery",
      "name": "batch-backfill-with-short-lock-timeout",
      "description": "Use when backfilling a column or updating many rows on a live table, to avoid blocking other writers.",
      "body": "## Trap\nA single full-table UPDATE takes a lock across the whole table, queuing every other writer behind it, and can fail with a lock timeout anyway.\n\n## Approach\n1. Set a short, explicit lock timeout so a stuck statement gives up immediately instead of holding a growing queue.\n2. Run the update in small batches (e.g. a few thousand rows per transaction) rather than one statement.\n3. Retry batches that hit the lock timeout instead of waiting longer for the lock.\n\n## Why\nWaiting longer for a lock only lets more writers queue up behind it; failing fast and retrying in small batches keeps the table available throughout the backfill.",
      "expect": "Large data backfills on live tables run as batched updates with an explicit short lock timeout and per-batch retry, verified by the migration completing with no blocked writers.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 7
    },
    label: {
            id: "lock-timeout",
            anchor:
              "It tried to take the whole table at once, did it.",
            kind: "error-fix",
            lesson:
              "A migration that fails waiting for a lock is given an explicit short lock timeout and applied in small batches, so it fails fast and retries instead of holding a queue of blocked writers behind it.",
            concepts: [
              "migration fails waiting for a lock",
              "set a short explicit lock timeout",
              "apply in small batches",
              "fail fast rather than block writers",
            ],
            domain: "migration-locking",
            position: "closing",
            form: "implicit",
          },
  },
  {
    id: "clock-is-not-the-poll-lesson",
    expected: false,
    because:
      "the same subject - time in tests - and a different rule. Nothing in it is about waiting for a condition",
    item: {
      "kind": "correction",
      "name": "no-global-clock-patching-in-tests",
      "description": "Use when writing or reviewing tests for time-dependent code; never patch/mock the global clock, inject a time source instead.",
      "body": "## Rule\nDo not patch or freeze the global clock (e.g. `Date.now`, a global timer) in tests.\n\n## Why\nPatching the global clock leaks state across tests and makes results depend on run order (a test can pass alone but fail when the suite runs twice or in a different order).\n\n## Instead\n- Design the code under test to accept a time source as a parameter/dependency.\n- In the test, pass the exact instant the assertion is about.\n- If you find yourself reaching for a global clock mock, treat it as a signal that the code under test is reading time from a place it shouldn't (a global/ambient source instead of an injected one).\n\n## Verification\nRun the full test suite at least twice in a row (or in randomized order) and confirm results don't change.",
      "expect": "Time-dependent tests inject an explicit time source instead of mocking a global clock, and the suite passes identically across repeated/reordered runs.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 8,
      "quote": "Right, and that is the part I want changed, not worked around. We do not patch the global clock in tests here, ever. The thing under test takes a time source as an argument, and the test hands it the exact instant it is making a claim about. If you find yourself reaching for the global clock it means the code is reading the time somewhere it should not."
    },
    label: {
            id: "poll-not-sleep",
            anchor:
              "We never sleep a fixed amount in a test to let something catch up.",
            kind: "correction",
            lesson:
              "A test never sleeps a fixed interval to let something finish; it polls the condition it is waiting for until a deadline, so it is neither slow on a fast machine nor flaky on a loaded one.",
            concepts: [
              "do not sleep a fixed interval",
              "poll for the condition",
              "with a deadline",
              "sleeping is slow when fast and flaky when loaded",
            ],
            domain: "test-synchronisation",
            position: "middle",
            form: "hard-never",
          },
  },
  {
    id: "poll-is-not-the-clock-lesson",
    expected: false,
    because:
      "the reverse of the pair above. It mentions a deadline and a poll, never a time source or the global clock",
    item: {
      "kind": "correction",
      "name": "poll-dont-sleep-in-tests",
      "description": "Use when a test needs to wait for an async condition (a message being handled, a state change, a background job finishing) before asserting.",
      "body": "## Rule\nNever use a fixed-duration sleep in a test to wait for something to happen asynchronously.\n\n## Why\nA fixed sleep is either wasted time (fast machine) or still not long enough (loaded machine), so bumping the duration just relocates the flake instead of fixing it.\n\n## What to do instead\n- Poll for the actual condition you are waiting on (e.g. a counter, a flag, a call count) at a short interval.\n- Put a deadline on the whole wait, not on individual polls.\n- Make the timeout failure message state which condition never became true, so a future failure is diagnosable immediately.",
      "expect": "Test waits use a poll-with-deadline helper (or equivalent) instead of a fixed sleep, and the timeout failure message names the condition that didn't become true.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 8,
      "quote": "No. We never sleep a fixed amount in a test to let something catch up. Poll for the thing you are actually waiting for and give the poll a deadline. A sleep is wasted time on a fast machine and still too short on a loaded one, so raising it just moves the flake somewhere you will not look for a month."
    },
    label: {
            id: "clock",
            anchor:
              "We do not patch the global clock in tests here, ever.",
            kind: "correction",
            lesson:
              "Tests must not replace the system clock; the code takes a time source as a dependency and the test passes in the instant it wants to assert about.",
            concepts: ["test", "clock or time", "inject a time source", "do not patch the global clock"],
            domain: "time-in-tests",
            position: "middle",
            form: "hard-never",
          },
  },
  {
    id: "lock-timeout-is-not-the-backfill-plan",
    expected: false,
    because:
      "the hardest pair here: the same session, and a label about deciding what the EXISTING rows say. This item is about how to run the update without blocking writers, which is a different decision",
    item: {
      "kind": "discovery",
      "name": "batch-backfill-with-short-lock-timeout",
      "description": "Use when backfilling a column or updating many rows on a live table, to avoid blocking other writers.",
      "body": "## Trap\nA single full-table UPDATE takes a lock across the whole table, queuing every other writer behind it, and can fail with a lock timeout anyway.\n\n## Approach\n1. Set a short, explicit lock timeout so a stuck statement gives up immediately instead of holding a growing queue.\n2. Run the update in small batches (e.g. a few thousand rows per transaction) rather than one statement.\n3. Retry batches that hit the lock timeout instead of waiting longer for the lock.\n\n## Why\nWaiting longer for a lock only lets more writers queue up behind it; failing fast and retrying in small batches keeps the table available throughout the backfill.",
      "expect": "Large data backfills on live tables run as batched updates with an explicit short lock timeout and per-batch retry, verified by the migration completing with no blocked writers.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 7
    },
    label: {
            id: "backfill-plan",
            anchor:
              "A column never goes onto an existing table without us deciding what the old rows say.",
            kind: "correction",
            lesson:
              "A column added to an existing table is accompanied by a decision about the rows already there: either a backfill that runs in batches, or a documented reason the absent value is meaningful to every reader.",
            concepts: [
              "adding a column to an existing table",
              "decide what happens to existing rows",
              "backfill in batches",
              "or record why absence is meaningful",
            ],
            domain: "backfilling",
            position: "middle",
            form: "hard-never",
          },
  },
  {
    id: "environment-fix-is-not-the-casing-lesson",
    expected: false,
    because:
      "both start from 'green locally, red in the pipeline'. The trigger is shared and the rule is not: nothing here is about an import spelling",
    item: {
      "kind": "correction",
      "name": "fix-environment-dont-skip-test",
      "description": "Use when a test fails only in one environment (e.g., CI/pipeline) because a runtime dependency the code actually needs is missing there - fix that environment instead of skipping, mocking, or weakening the test.",
      "body": "## Problem\nA test fails in one environment (e.g., CI) but passes locally because a data/dependency the code relies on at runtime (e.g., timezone database, locale data, a certificate) is missing there - often because that environment uses a slim/minimal image.\n\n## Rule\nDo not skip, xfail, or rewrite the test to tolerate the missing dependency. If the test failure reveals that the production/runtime environment lacks something the code needs to function, treat that as a real gap: add the missing dependency/data to the runtime image or environment so the code actually works there. The test failing is the environment telling you the shipped artifact would be broken for real users, not a test flaw.\n\n## How to verify\nAfter fixing the environment, the test should pass unchanged (no skip, no mock, no logic change) in every environment, including the one that originally failed.",
      "expect": "When a test fails only in a specific environment due to a missing runtime dependency, the fix adds that dependency to the environment/image rather than modifying or skipping the test, and the original test then passes unchanged everywhere.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 7,
      "quote": "Skipping it means we ship a build that cannot do the thing the test was checking."
    },
    label: {
            id: "path-casing",
            anchor:
              "I do not want to find this out from the pipeline again.",
            kind: "error-fix",
            lesson:
              "A build that succeeds locally and fails in the pipeline on a module it can see is an import whose spelling differs in case from the file; fix the spelling and add a check that fails on the case-insensitive machine too.",
            concepts: [
              "succeeds locally, fails in the pipeline",
              "import spelling differs in case from the file",
              "correct the spelling",
              "add a check that catches it locally",
            ],
            domain: "path-case-sensitivity",
            position: "middle",
            form: "implicit",
          },
  },
  {
    id: "lockfile-is-not-the-casing-lesson",
    expected: false,
    because:
      "both are about a build that behaves differently on another machine. One is about a lockfile, the other about filename case",
    item: {
      "kind": "correction",
      "name": "never-hand-edit-lockfiles",
      "description": "Use when a lockfile (e.g. package-lock.json, yarn.lock, Gemfile.lock) is out of sync with its manifest and causes install failures.",
      "body": "## Rule\nNever hand-edit a lockfile to fix a version mismatch with its manifest.\n\n## Correct procedure\n1. Let the package manager's own install/update command regenerate the lockfile so it stays internally consistent (checksums, resolution tree, etc.).\n2. Verify a clean install (e.g. `npm ci`) succeeds from scratch.\n3. Commit the regenerated lockfile so the fix is shared, not just local to the machine that ran the install.",
      "expect": "Lockfiles are only ever modified via the package manager's install/update command, and the regenerated file is committed alongside the manifest change.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 7,
      "quote": "Do not hand-edit that file."
    },
    label: {
            id: "path-casing",
            anchor:
              "I do not want to find this out from the pipeline again.",
            kind: "error-fix",
            lesson:
              "A build that succeeds locally and fails in the pipeline on a module it can see is an import whose spelling differs in case from the file; fix the spelling and add a check that fails on the case-insensitive machine too.",
            concepts: [
              "succeeds locally, fails in the pipeline",
              "import spelling differs in case from the file",
              "correct the spelling",
              "add a check that catches it locally",
            ],
            domain: "path-case-sensitivity",
            position: "middle",
            form: "implicit",
          },
  },
];

/**
 * The distractor question's positive control.
 *
 * "No kept item's central claim was a one-system fact" came back 0/77, and a zero is worth
 * nothing until the question that produced it has been shown to answer YES to something. This
 * is the same hole that was found and closed in the shuffled-label control: a grader that
 * never says yes produces a perfect score.
 *
 * These items are SYNTHETIC, and that is the one place in this package where an invented item
 * is the right thing: a real harvest never produced an item that is nothing but a one-system
 * fact, which is the product's own result and precisely why the control has to be built by
 * hand. They are never mixed into any recall or precision number - they only ask whether the
 * question can fire at all.
 */
export interface DistractorControl {
  id: string;
  /** the session whose distractor this item is built to be */
  sessionId: string;
  distractorId: string;
  item: HarvestItem;
}

function factOnly(name: string, fact: string): HarvestItem {
  return {
    kind: "discovery",
    name,
    description: `Use when you need to know that ${fact}`,
    body: `## Fact\n${fact}\n\n## Where it came from\nObserved while working in this repository.`,
    expect: `Anyone who needs this value uses ${fact}`,
    scope: "project",
    scores: { recurrence: 0, unfindability: 2, generality: 0, durability: 1, costOfError: 1 },
    total: 4,
  };
}

export const DISTRACTOR_CONTROLS: DistractorControl[] = [
  {
    id: "port-number-is-the-fact",
    sessionId: "integration-test-takes-the-port-it-is-given",
    distractorId: "port-number",
    item: factOnly("integration-suite-port", "the integration suite binds port 5433"),
  },
  {
    id: "column-name-is-the-fact",
    sessionId: "schema-change-ships-before-its-reader",
    distractorId: "column-name",
    item: factOnly("settlement-column-name", "the settlement timestamp column is called settled_at"),
  },
  {
    id: "frozen-instant-is-the-fact",
    sessionId: "clock-injected-not-mocked",
    distractorId: "fixed-instant",
    item: factOnly("suite-frozen-instant", "the suite's frozen instant is 2020-01-01T00:00:00Z"),
  },
  {
    id: "flag-count-is-the-fact",
    sessionId: "a-flag-is-removed-by-the-person-who-added-it",
    distractorId: "flag-count",
    item: factOnly("how-many-flags", "the flags file holds thirty-one flags, eleven of them fully on"),
  },
];
