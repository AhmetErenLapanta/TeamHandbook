// The grader's test set for the question tier 2 asks: is this item the same lesson as one
// NOBODY IN THE SESSION EVER STATED?
//
// The tier-1 set cannot answer that. Its pairs are items written from a rule the developer said
// out loud, matched against a sentence that says the same thing, and 10/10 there says nothing
// about a grader reading an item against a reference that appears nowhere in the transcript -
// which is most of this tier. So the check is repeated with pairs of that kind and the bar is
// the same: agreement on at least nine of ten, per repeat.
//
// Same rule as the tier-1 set, and it is the rule that makes the number mean anything: every
// item here is a VERBATIM output of a pilot run of this package against the tier-2 corpus,
// copied out of `material-1/<session>.json`. None is invented. Nine of the ten references are
// `unstated` or `implicit` labels. The expected verdict and the one-line reason were written
// while reading the item against the label and before the grader was asked anything.
//
// Five are YES and five are NO, and the NO half is deliberately hard: every one of them pairs
// an item with a reference from the same subject area - two ways of representing a quantity,
// two ordered procedures that both end in a suite run, two release-incident procedures - and
// two of them are the same pair in both directions, because a grader that leans on topic
// similarity fails one direction while passing the other.
import type { GraderCase } from "./grader-cases.js";
import { SESSIONS } from "./corpus.js";
import type { Label } from "./corpus.js";

/** The label as the corpus holds it, by id, so a case cannot drift from the corpus it grades
 * against - the tier-1 set copies its labels inline and a later edit to the corpus would
 * silently leave them behind. */
function label(id: string): Label {
  const found = SESSIONS.flatMap((s) => s.labels).find((l) => l.id === id);
  if (!found) throw new Error(`grader case names a label that is not in the corpus: ${id}`);
  return found;
}

export const GRADER_CASES_TIER2: GraderCase[] = [
  {
    id: "comment-reason-is-the-comment-lesson",
    expected: true,
    because:
      "the same rule from a session where nobody stated it: the comment gives the reason, names what the code cannot show, and says a restatement adds nothing",
    item: {
      "kind": "correction",
      "name": "comments-explain-why-not-what",
      "description": "Use when adding a code comment: state the hidden constraint or reason behind a choice, not a paraphrase of what the adjacent code visibly does.",
      "body": "## Rule\nA comment that restates control flow (\"the loop iterates over X\", \"the counter increments per Y\") adds no value — a reader can already see that from the code.\n\nA comment earns its place when it records something the code cannot show on its own:\n- the origin of a magic number or threshold (e.g. why a batch size or retry count was picked)\n- an external constraint driving a value (a partner's retry window, a lock/timeout budget, a contractual deadline)\n- a workaround for a specific bug or limitation\n\n## Check before writing a comment\nAsk: \"could a reader infer this by reading the code next to it?\" If yes, drop the comment. If no — because the reason lives outside the file (business rule, incident history, external system behavior) — write it down.",
      "expect": "New comments state a non-obvious reason or constraint (why a value/behavior was chosen) rather than describing what the surrounding code does.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 1
      },
      "total": 6,
      "quote": "I rewrote both of the comments you added in the sweep. Pull and look at the diff before you carry on with the rest of it."
    },
    label: label("comment-carries-the-reason"),
  },
  {
    id: "one-caller-is-the-extraction-lesson",
    expected: true,
    because:
      "carries all three: do not extract for one caller, wait for a second real one, no generalising parameters ahead of need",
    item: {
      "kind": "correction",
      "name": "dont-extract-single-caller-code",
      "description": "Use when refactoring or writing new logic that currently has exactly one call site: keep the body inline in that caller instead of pulling it into its own named function, and wait for a second real caller before extracting.",
      "body": "## Rule\nDo not factor logic into a separate function, helper, or exported utility just because it *could* be reused, or to make it \"general\" with an options/parameter object, when there is currently only one caller.\n\n## Why\nA developer reverted this exact move twice in one session: once for a validator helper, once for a comparison function, each time replacing the extracted function with its body inlined at the single call site, and removing the generalizing parameter object along with it.\n\n## What to do instead\n- Write the logic directly where it is used.\n- Only extract it into its own function once a second real caller shows up.\n- Do not add options/parameter objects to make a single-use function \"flexible\" ahead of need.",
      "expect": "When implementing logic that has only one call site, the assistant writes it inline in that caller rather than creating a new named function or exported helper, and does not add generalizing parameters for hypothetical future callers.",
      "scope": "team",
      "scores": {
        "recurrence": 1,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 1
      },
      "total": 7,
      "quote": "Bunu da geri aldım, ikinci bir çağıranı olmadan ayrı bir fonksiyona koymuşsun yine. Yerine gövdeyi koydum."
    },
    label: label("no-abstraction-for-one-caller"),
  },
  {
    id: "temp-dir-is-the-shared-path-lesson",
    expected: true,
    because:
      "same rule, and emitted as an error-fix against a correction-shaped reference, so it also tests that the grader ignores the kind",
    item: {
      "kind": "error-fix",
      "name": "give-each-test-its-own-temp-directory",
      "description": "Use when tests pass individually but fail intermittently in the full suite: check for a shared hardcoded output directory before assuming a logic bug.",
      "body": "## Symptom\nTwo or more test files fail only when the suite runs with multiple workers; each passes when run alone.\n\n## Root cause\nMultiple test files write into the same hardcoded directory (a fixed path, not unique per test) and race each other, deleting one another's files between write and read.\n\n## Fix\nHave each affected test create its own directory under the OS temp path in setup, and remove it in teardown, instead of sharing one fixed-name path.\n\n## Aftercare\nSearch the rest of the module for other files still pointing at the same fixed path - this kind of bug tends to be duplicated in more than one place.",
      "expect": "The full-suite test run passes with multiple workers as well as with one, and no test file in the module references a shared hardcoded directory.",
      "scope": "team",
      "scores": {
        "recurrence": 2,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 9,
      "source": "pair:1e6540b093059a95"
    },
    label: label("temp-dir-per-test"),
  },
  {
    id: "snapshot-scrub-is-the-refresh-procedure",
    expected: true,
    because:
      "all four steps in order, including that nothing unmasked reaches the test database",
    item: {
      "kind": "procedure",
      "name": "refresh-test-data-from-a-snapshot-with-pii-scrubbing",
      "description": "Use when test fixtures or the test database are stale and need refreshing from real data: restore from a recent snapshot rather than the live database, scrub personal fields before the data touches any test environment, load it into an isolated database, and clean up the scratch copy afterward.",
      "body": "## Goal\nRefresh test data safely when it has drifted from production shapes.\n\n## Steps\n1. Restore from the most recent snapshot into a scratch database that nothing else points at — never connect directly to the live/production database.\n2. In the scratch copy, replace every personal field (names, addresses, contact details, date of birth, national/government identifiers) with non-identifying values that preserve realistic shape (length, format, checksum validity) rather than nulling them out.\n3. Load the scrubbed scratch copy into the test database.\n4. Run the full suite against it and update any tests that asserted on a field that is now generated.\n5. Drop the scratch database once loading is confirmed successful.\n\n## Verification\nSuite passes against the refreshed test database, and no step read from or wrote to the live/production database.",
      "expect": "Test data is refreshed without any direct connection to the live/production database, all personal fields are replaced with non-identifying values before reaching the test database, and the scratch copy is dropped after use.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 8,
      "task": {
        "goal": "Refresh stale test data from real data without exposing PII or touching production directly",
        "steps": [
          "Restore from a recent snapshot into an isolated scratch database, not the live database",
          "Replace personal fields in the scratch copy with non-identifying but shape-preserving values",
          "Load the scrubbed copy into the test database",
          "Run the suite and update any tests coupled to now-generated fields",
          "Drop the scratch database"
        ],
        "verification": "Full suite passes against the refreshed test database"
      }
    },
    label: label("fixture-refresh-steps"),
  },
  {
    id: "minor-units-is-the-money-lesson",
    expected: true,
    because:
      "integer minor units, currency alongside, and both rounding steps named",
    item: {
      "kind": "correction",
      "name": "money-fields-as-minor-units",
      "description": "Use when adding, fixing, or reviewing a monetary amount field in code or an API response: store and transmit it as an integer of minor units paired with its currency code, never as a bare float or decimal.",
      "body": "## Rule\nRepresent monetary amounts as an integer count of minor units (e.g. cents) together with an explicit currency code, not as a floating-point or plain decimal number.\n\n## Why\nA decimal/float amount gets rounded once when it is stored and again when it is serialized, so the drift accumulates across many records until a reconciliation check catches it. An integer of minor units removes both rounding steps.\n\n## Apply\n- When adding a new monetary field to a response, match the integer-minor-units + currency shape already used by sibling amount fields, instead of introducing a decimal.\n- Keep the amount and its currency code together as one pair; never let an amount travel without its currency, since two amounts can only be compared or summed once you know they share a currency.",
      "expect": "New or fixed monetary amount fields are added as an integer of minor units with an adjacent currency field, matching existing amount fields in the same response, rather than as a decimal or float.",
      "scope": "team",
      "scores": {
        "recurrence": 1,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 9,
      "quote": "Changed that one too, same as the other: integer minor units, currency alongside it. Two currencies are in use today so the pair has to travel together."
    },
    label: label("money-in-minor-units"),
  },
  {
    id: "unit-suffix-is-not-the-money-lesson",
    expected: false,
    because:
      "HARD: both are about how a quantity is represented, and the reference is specifically about money in minor units with its currency",
    item: {
      "kind": "correction",
      "name": "name-time-values-with-explicit-units",
      "description": "Use when adding, renaming, or fixing a duration/interval/lifetime setting or constant.",
      "body": "## Rule\nGive time-based settings and constants a name that states the unit explicitly (e.g. `_seconds`, `_ms`), not a bare word like `interval` or `lifetime`. An ambiguous name invites the next reader (or the assistant) to guess the unit and multiply or divide incorrectly.\n\n## When fixing a unit-conversion bug\nOnce you find one place that got the unit wrong, check every other caller of the same value for the identical mistake before moving on — the same ambiguous name likely misled more than one call site.",
      "expect": "New or renamed time-based constants carry an explicit unit suffix, and after fixing a unit bug, all callers of that value are checked and any doing the same wrong conversion are corrected.",
      "scope": "team",
      "scores": {
        "recurrence": 1,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 9,
      "quote": "you had it multiplying by sixty on a value that was already in seconds, so the poll was sitting there for forty-five minutes"
    },
    label: label("money-in-minor-units"),
  },
  {
    id: "money-is-not-the-unit-suffix-lesson",
    expected: false,
    because:
      "HARD: the reverse direction of the pair above, which a grader leaning on topic similarity would get wrong in one direction only",
    item: {
      "kind": "correction",
      "name": "money-fields-as-minor-units",
      "description": "Use when adding, fixing, or reviewing a monetary amount field in code or an API response: store and transmit it as an integer of minor units paired with its currency code, never as a bare float or decimal.",
      "body": "## Rule\nRepresent monetary amounts as an integer count of minor units (e.g. cents) together with an explicit currency code, not as a floating-point or plain decimal number.\n\n## Why\nA decimal/float amount gets rounded once when it is stored and again when it is serialized, so the drift accumulates across many records until a reconciliation check catches it. An integer of minor units removes both rounding steps.\n\n## Apply\n- When adding a new monetary field to a response, match the integer-minor-units + currency shape already used by sibling amount fields, instead of introducing a decimal.\n- Keep the amount and its currency code together as one pair; never let an amount travel without its currency, since two amounts can only be compared or summed once you know they share a currency.",
      "expect": "New or fixed monetary amount fields are added as an integer of minor units with an adjacent currency field, matching existing amount fields in the same response, rather than as a decimal or float.",
      "scope": "team",
      "scores": {
        "recurrence": 1,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 9,
      "quote": "Changed that one too, same as the other: integer minor units, currency alongside it. Two currencies are in use today so the pair has to travel together."
    },
    label: label("unit-in-the-name"),
  },
  {
    id: "housekeeping-is-not-the-refresh-procedure",
    expected: false,
    because:
      "HARD: both are ordered procedures run before the real work, and both end in a suite run; different work entirely",
    item: {
      "kind": "procedure",
      "name": "run-mechanical-housekeeping-before-feature-work",
      "description": "Use when starting real work in a directory: first sweep it for the small mechanical debts (sorted exports, unused helpers, duplicate imports, vague test names, dead code, missing headers) so they don't leak into the feature diff.",
      "body": "## Goal\nClear cosmetic/mechanical debt out of a directory before starting the actual feature, so the feature diff stays focused and doesn't shuffle unrelated lines.\n\n## Steps\n1. Sort exported names in the directory's index/barrel file.\n2. Find unused private helpers and remove them — but check whether any are referenced only from a test before deleting; keep those.\n3. Collapse duplicate imports of the same symbol (e.g. a type imported both as `type` and as a value).\n4. Rename vague test names (e.g. \"works\", \"works 2\") to describe the behavior they actually assert.\n5. Remove commented-out dead code blocks left from earlier rewrites.\n6. Add any missing required file headers (e.g. license headers) to the newest files that lack them.\n\n## Verification\nRun the full test suite: the count of passing tests should be identical before and after, and the diff should only touch the items above — nothing else in the directory.",
      "expect": "Before starting the main task in a directory, the assistant runs this checklist in order, reports the resulting file/line counts, and the test suite count stays unchanged.",
      "scope": "team",
      "scores": {
        "recurrence": 2,
        "unfindability": 1,
        "generality": 2,
        "durability": 1,
        "costOfError": 1
      },
      "total": 7,
      "task": {
        "goal": "Clear mechanical debt (sorting, dead code, duplicate imports, vague test names, missing headers) from a directory before starting feature work.",
        "steps": [
          "Sort exported names in the barrel/index file",
          "Remove unused helpers, keeping any still referenced from tests",
          "Collapse duplicate type/value imports of the same symbol",
          "Rename vague test names to describe the asserted behavior",
          "Remove commented-out dead code",
          "Add missing file headers to newest files"
        ],
        "verification": "Test suite count unchanged after the sweep; diff limited to the listed mechanical changes"
      }
    },
    label: label("fixture-refresh-steps"),
  },
  {
    id: "dead-code-check-is-not-the-extraction-lesson",
    expected: false,
    because:
      "HARD: both are about whether a piece of code should exist, from the same session; one is about extracting, the other about deleting",
    item: {
      "kind": "discovery",
      "name": "check-tests-before-deleting-unused-code",
      "description": "Use when removing code flagged as unused: search test files for direct references too, not just the production import graph, before deleting.",
      "body": "## Before deleting seemingly-dead code\n- A function can be unused in the production module graph but still referenced directly from a test file.\n- Grep test directories for the symbol name, not just other source files, before removing it.\n- Keep anything still referenced by a test even if nothing in the shipped code calls it.",
      "expect": "When cleaning up unused helpers/functions, the assistant checks test files for direct references and skips deleting anything a test still uses, instead of relying only on production import usage.",
      "scope": "team",
      "scores": {
        "recurrence": 1,
        "unfindability": 1,
        "generality": 2,
        "durability": 2,
        "costOfError": 1
      },
      "total": 7
    },
    label: label("no-abstraction-for-one-caller"),
  },
  {
    id: "hotfix-branching-is-not-the-rollback-order",
    expected: false,
    because:
      "HARD: both are release-incident procedures naming the deployed revision and the main line; one ships a fix, the other undoes one",
    item: {
      "kind": "correction",
      "name": "hotfix-branch-from-deployed-revision",
      "description": "Use when a fix must ship to production urgently: branch from the commit that is actually deployed, not from the tip of the main branch, and land the fix on both.",
      "body": "## Why\nWhen an urgent fix is needed, the main/default branch may already be ahead of what is running in production (unreleased work, half-finished features). Branching a hotfix from the tip of main risks shipping that unreleased work along with the fix.\n\n## Steps\n1. Before branching, check how far the main branch is ahead of the deployed revision (e.g. via the deploy tag/commit reference).\n2. Create the hotfix branch from the deployed revision, not from the current tip of main.\n3. Apply the minimal fix on that branch and ship it.\n4. Separately, apply the same fix as its own commit on top of the current main branch, so the fix isn't only on the throwaway hotfix branch.\n5. Cross-reference the two commits (note the other's reference) so the duplication is traceable later.\n\n## Verification\nThe hotfix branch's parent is the deployed commit (confirmed ahead-count), and the fix also exists as a distinct commit on main referencing the hotfix commit.",
      "expect": "For an urgent production fix, the fix branch is created from the deployed commit (after checking how far main is ahead) rather than from HEAD of main, and the same fix is also committed onto main with a cross-reference between the two.",
      "scope": "team",
      "scores": {
        "recurrence": 0,
        "unfindability": 2,
        "generality": 2,
        "durability": 2,
        "costOfError": 2
      },
      "total": 8,
      "quote": "Branch it off what is actually running instead. How far ahead is the main line? ... Right. And do not leave it only there."
    },
    label: label("rollback-order"),
  },
];
