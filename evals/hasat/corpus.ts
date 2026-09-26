// The golden corpus: synthetic coding sessions, each with the lessons it contains
// written down separately, so the harvest can be asked what fraction of them it finds.
//
// Everything here is invented. No real path, account name, company, product or
// repository appears, and nothing was copied out of a real session or a real queue -
// real material was read only to learn what shape a distracting one-system fact takes.
//
// Two rules hold the measurement up, and both are asserted in corpus.test.ts:
//
//   - A label's canonical sentence is the GRADER's reference, never a line of the
//     transcript. The developer states the rule in their own words, in a turn a human
//     could have typed; the assistant never closes with the label's wording. Otherwise
//     the number measures copying.
//   - Lessons are distinct across sessions, and each carries a `domain`. The
//     shuffled-label control pairs a session's items with ANOTHER session's labels, and
//     a grader that says yes there is saying yes to nothing; two labels from the same
//     domain would make that answer legitimately hard rather than wrong.

import type { SkillSummary } from "../../src/lib/skill-index.js";
import { TIER2_SESSIONS } from "./corpus-tier2.js";

export type LabelKind = "correction" | "procedure" | "error-fix";

/** Where in the conversation the lesson is stated. The slicer spends its budget
 * newest-first, so an early lesson in a long session is the one it can drop. */
export type Position = "opening" | "middle" | "closing" | "repeated";

/**
 * How the lesson is stated.
 *
 * `implicit` is a developer pushing back until the assistant does it their way: no rule
 * sentence, but the pushback is about the general case ("not that way, the other way").
 * `unstated` is the harder one tier 2 adds: nobody ever generalises at all. The same
 * mistake is corrected twice on its own terms, or a procedure is simply carried out in
 * order, and the lesson exists only in what the session DID. There is no sentence to
 * quote, which is also what makes it the case a real session is usually made of.
 */
export type Form = "hard-never" | "soft-henceforth" | "implicit" | "unstated";

export interface Label {
  id: string;
  kind: LabelKind;
  /** the lesson in one sentence, for the grader to compare an item against */
  lesson: string;
  /** what any faithful statement of this lesson has to carry */
  concepts: string[];
  /**
   * A verbatim fragment of the developer's OWN turn that carries this lesson. It is not
   * the canonical sentence above and is never written into an assistant turn, so it
   * cannot be what a model copies. Its only job is deterministic attribution: whether
   * the lesson reached the transcript slice at all, and whether it reached the recorded
   * prompts, which is what splits a recall miss into a loss before the model, a model
   * miss, and a sieve drop.
   *
   * For an `implicit` label there is no rule sentence to point at, so the anchor is the
   * pivotal turn of the exchange instead. Attribution is correspondingly weaker there,
   * and the report says so.
   */
  anchor: string;
  /** coarse subject, so the shuffled-label control never pairs two lessons that are
   * genuinely about the same thing */
  domain: string;
  position: Position;
  form: Form;
  /**
   * An existing skill in this session's injected list ALREADY covers this lesson, named
   * here by its slug. The prompt tells the model to produce nothing that overlaps an
   * existing skill, so the right outcome is that nothing comes back for this label - which
   * makes it the opposite of a recall case. It leaves every recall denominator and is
   * counted as suppression instead, and an item that comes back for it anyway is reported
   * whether the sieve's duplicate rule caught it or not.
   */
  coveredBy?: string;
  /**
   * Which evidence path is EXPECTED to carry this lesson, measured rather than assumed and
   * asserted by `corpus.test.ts`. Both default to true. A tier-2 lesson stated inside a
   * turn longer than the recorder's 600-character line reaches the model through the slice
   * only, which is the production mix and not a defect - but it has to be declared, or a
   * recall miss cannot be told from a lesson the model never saw.
   */
  presence?: { slice?: boolean; corrections?: boolean };
}

/** A true fact about ONE system. A good harvest may mention it; it must not propose it
 * as the lesson, because stripped of its proper names nothing is left to do. */
export interface Distractor {
  id: string;
  fact: string;
  concepts: string[];
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
  /** a tool call hung off this turn: the assistant turn gets a tool_use block beside
   * its text and a tool_result line follows it. Both are skipped by
   * readTranscriptTexts, and a transcript without them is not the shape the product
   * reads. */
  tool?: { name: string; input: Record<string, unknown>; result: string };
  /** a subagent line. The reader drops it, and a lesson planted here must NOT be
   * found - so nothing is ever planted here. */
  sidechain?: true;
  /** a line Claude Code injected rather than a human typing it (a slash command's
   * expanded body, a system notice). Also dropped by the reader. */
  meta?: true;
}

/** Deterministic evidence, driven through the product's own capture functions in
 * order, exactly as a post-tool-use hook would. */
export interface WorkEvent {
  kind: "bash-fail" | "bash-ok" | "edit";
  command?: string;
  /** the stderr body; the fixture wraps it in the `Exit code N` envelope the hook sees */
  error?: string;
  file?: string;
}

export interface CorpusSession {
  id: string;
  /**
   * Which measurement this session belongs to. 1 is the legible corpus the headline band
   * was taken on; 2 is the dense one, where the slice fills, the lesson is one turn among
   * twenty, and a full existing-skill list is injected. They are reported apart and never
   * pooled: a mean over both would be a number describing a corpus nobody designed.
   */
  tier: 1 | 2;
  /**
   * The existing-skill list the harvest prompt is shown, as `listSkills` would have
   * returned it. Tier 1 injects an empty one, which is why its precision can only be
   * higher than production's and why the sieve's duplicate rule was never exercised
   * there. Tier 2 injects three to five, and in three sessions one of them covers the
   * session's own lesson.
   */
  existingSkills?: SkillSummary[];
  /** the language of the USER's turns. The detectors carry other languages as data, so
   * the harvest prompt has to as well. */
  language: "en" | "tr" | "mixed";
  turns: Turn[];
  labels: Label[];
  distractors: Distractor[];
  work: WorkEvent[];
}

// ── shared building blocks ──────────────────────────────────────────────────

const READ = (path: string, result: string): Turn["tool"] => ({
  name: "Read",
  input: { file_path: path },
  result,
});

/** Errand turns for the two long sessions. Varied rather than repeated, so the slice
 * the model reads looks like a working session and not a stuck loop. */
const ERRANDS: string[] = [
  "Can you show me where the retry count is configured for the outbound queue?",
  "The listing endpoint is slower than it was last week. Anything obvious in the query?",
  "Rename the helper to something that says what it returns, then update the callers.",
  "There is a stray console statement in the checkout handler. Take it out.",
  "Pull the magic number in the pagination code up into a named constant.",
  "Add the missing type annotation on the exported factory so the build stops warning.",
  "The changelog entry for the last release is missing a line about the new field.",
  "Two helpers do almost the same thing. Keep the one with tests and drop the other.",
  "The error message when the token is expired does not say what to do next.",
  "Split the long handler into the parse step and the write step.",
  "Sort the exported names so the diff on this file stops shuffling every time.",
  "Drop the unused import the last refactor left behind in the worker entrypoint.",
  "The fixture builder takes six positional arguments now. Make it take an object.",
  "Put the timeout for the outbound call behind the same config object as the rest.",
  "The integration test writes into the repository directory. Point it at a temp one.",
];

/** Enough areas that an errand plus an area is a distinct sentence for 45 turns running.
 * Distinctness is load-bearing rather than cosmetic: the prompt recorder drops a prompt
 * repeated verbatim, so a cycled errand list would silently stop growing the record and
 * the session that measures the 40-prompt ceiling would never reach it. */
const AREAS = ["checkout", "catalog", "payout", "notification", "reporting"];

function errand(i: number): { text: string; area: string; errand: string } {
  const e = ERRANDS[i % ERRANDS.length]!;
  const area = AREAS[Math.floor(i / ERRANDS.length) % AREAS.length]!;
  return { text: `${e} This one is in the ${area} module.`, area, errand: e };
}

function errandTurns(count: number, startAt = 0): Turn[] {
  const turns: Turn[] = [];
  for (let i = startAt; i < startAt + count; i++) {
    const { text, area, errand: e } = errand(i);
    turns.push({ role: "user", text });
    turns.push({
      role: "assistant",
      text: `Done. ${e.slice(0, 40)}\u2026 handled in ${area}; the suite is still green.`,
    });
  }
  return turns;
}

/**
 * Errand turns grown to an exact length, which is the only way to aim at the two
 * thresholds that decide what evidence a lesson reaches the model through:
 *
 *   - the prompt recorder ignores a prompt longer than 600 characters, on the grounds that
 *     it is a task brief rather than a rule. A filler above that line consumes the slice
 *     budget WITHOUT consuming one of the forty recorded prompts.
 *   - the slicer gives the user's turns 60% of the budget, newest-first, and SKIPS a
 *     message too big for what is left rather than stopping.
 *
 * Together those let a session be built where the lesson is dropped from the slice and
 * still present in the recorded prompts - which is the only way to tell "the model was
 * never shown it" apart from "the model was shown it and said nothing".
 */
function longErrandTurns(lengths: number[], startAt = 0): Turn[] {
  const turns: Turn[] = [];
  for (let i = 0; i < lengths.length; i++) {
    const { text, area, errand: e } = errand(startAt + i);
    const filler = "Background from the ticket, unchanged since it was written. ";
    let body = text;
    while (body.length < lengths[i]!) body += filler;
    turns.push({ role: "user", text: body.slice(0, lengths[i]!) });
    turns.push({
      role: "assistant",
      text: `Done. ${e.slice(0, 40)}\u2026 handled in ${area}; the suite is still green.`,
    });
  }
  return turns;
}

// ── the corpus ──────────────────────────────────────────────────────────────

const TIER1: Omit<CorpusSession, "tier">[] = [
  {
    id: "clock-injected-not-mocked",
    language: "en",
    labels: [
      {
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
    ],
    distractors: [
      {
        id: "fixed-instant",
        fact: "The suite's frozen instant is 2020-01-01T00:00:00Z.",
        concepts: ["2020-01-01", "frozen instant"],
      },
      {
        id: "time-helper-path",
        fact: "The time source helper lives in support/time.ts.",
        concepts: ["support/time.ts", "helper location"],
      },
    ],
    turns: [
      {
        role: "user",
        text: "MARKER_META_ONLY You are running a guided walkthrough. Introduce yourself and describe each step before taking it.",
        meta: true,
      },
      { role: "user", text: "The expiry test fails when I run the suite twice in a row. Can you look at it?" },
      {
        role: "assistant",
        text: "MARKER_SIDECHAIN_ONLY Subagent report: the helper under support is imported by nine files and none of them restore what they patch.",
        sidechain: true,
      },
      {
        role: "assistant",
        text: "The test patches the global clock and never restores it, so the second run starts with a frozen clock.",
        tool: READ("test/expiry.spec.ts", "beforeEach(() => patchGlobalClock('2020-01-01T00:00:00Z'))"),
      },
      {
        role: "user",
        text: "Right, and that is the part I want changed, not worked around. We do not patch the global clock in tests here, ever. The thing under test takes a time source as an argument, and the test hands it the exact instant it is making a claim about. If you find yourself reaching for the global clock it means the code is reading the time somewhere it should not.",
      },
      {
        role: "assistant",
        text: "Understood. I gave the expiry check a time source parameter and the test now passes the instant it asserts on, so nothing global is touched.",
        tool: { name: "Edit", input: { file_path: "src/expiry.ts" }, result: "1 edit applied" },
      },
      { role: "user", text: "Good. Run the suite twice to be sure the order stopped mattering." },
      {
        role: "assistant",
        text: "Both runs green. The frozen instant the suite uses is still 2020-01-01T00:00:00Z and the helper for it sits in support/time.ts, but nothing depends on the order now.",
      },
    ],
    work: [
      { kind: "bash-fail", command: "npm test", error: "1 failing: expiry returns a value in the past" },
      { kind: "edit", file: "src/expiry.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "schema-change-ships-before-its-reader",
    language: "en",
    labels: [
      {
        id: "migration-order",
        anchor:
          "the schema change goes out on its own first",
        kind: "procedure",
        lesson:
          "A schema change ships in its own release before any code that reads it: deploy the migration, confirm the new shape is present in every environment, and only then release the code that depends on it.",
        concepts: [
          "schema change in its own release",
          "deploy the migration first",
          "verify the new shape is present",
          "release the reading code afterwards",
        ],
        domain: "release-ordering",
        position: "closing",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "column-name",
        fact: "The new column is called settled_at.",
        concepts: ["settled_at", "column name"],
      },
      {
        id: "migration-number",
        fact: "The migration file is numbered 0042.",
        concepts: ["0042", "migration number"],
      },
    ],
    turns: [
      { role: "user", text: "I need the settlement timestamp on the payout record, and the report endpoint has to return it." },
      {
        role: "assistant",
        text: "I added the column in a migration and read it in the report serializer, both in this branch.",
        tool: { name: "Write", input: { file_path: "db/migrations/0042_add_settled_at.sql" }, result: "written" },
      },
      { role: "user", text: "Stop there. Those two cannot go out together." },
      { role: "assistant", text: "Because a serializer reading a column that is not there yet fails for every request until the migration lands?" },
      {
        role: "user",
        text: "That is it. From now on split it: the schema change goes out on its own first, we check the new shape is actually present everywhere it needs to be, and the code that reads it goes out in the release after. Two releases, in that order, always. It costs a day and saves an incident.",
      },
      {
        role: "assistant",
        text: "Split into two branches. The first carries only the migration; the second adds the serializer field and is not merged until the column is confirmed present. The column is settled_at and the migration is 0042 if you need to check by hand.",
      },
    ],
    work: [
      { kind: "edit", file: "db/migrations/0042_add_settled_at.sql" },
      { kind: "bash-ok", command: "npm run migrate" },
      { kind: "edit", file: "src/report/serializer.ts" },
    ],
  },

  {
    id: "integration-test-takes-the-port-it-is-given",
    language: "en",
    labels: [
      {
        id: "ephemeral-port",
        anchor:
          "Waiting for a port someone else is holding is not a fix",
        kind: "error-fix",
        lesson:
          "An integration test must not hard-code a listening port: bind port zero, read back the port the operating system assigned, and give that to the client, so two runs can never collide.",
        concepts: [
          "hard-coded port fails when something already holds it",
          "bind port zero",
          "read back the assigned port",
          "pass it to the client",
        ],
        domain: "test-port-binding",
        position: "middle",
        form: "implicit",
      },
    ],
    distractors: [
      {
        id: "port-number",
        fact: "The suite used to bind 5433.",
        concepts: ["5433", "port number"],
      },
    ],
    turns: [
      { role: "user", text: "The integration suite fails on my machine but passes in the pipeline. Address already in use." },
      {
        role: "assistant",
        text: "The harness binds a fixed port. Shall I add a retry so it waits for the port to free up?",
        tool: READ("test/harness.ts", "const PORT = 5433"),
      },
      { role: "user", text: "No. Waiting for a port someone else is holding is not a fix, it is a slower failure." },
      { role: "assistant", text: "Then I should not choose the port at all." },
      { role: "user", text: "Now you have it. Let the operating system pick and use whatever it gives you." },
      {
        role: "assistant",
        text: "The harness now listens on port zero, reads the assigned port off the server handle and builds the client base URL from it. Two suites can run at once. It used to bind 5433.",
        tool: { name: "Edit", input: { file_path: "test/harness.ts" }, result: "1 edit applied" },
      },
    ],
    work: [
      {
        kind: "bash-fail",
        command: "npm run test:integration",
        error: "listen EADDRINUSE: address already in use :::5433",
      },
      { kind: "edit", file: "test/harness.ts" },
      { kind: "bash-ok", command: "npm run test:integration" },
    ],
  },

  {
    id: "shared-history-moves-forward-only",
    language: "en",
    labels: [
      {
        id: "no-history-rewrite",
        anchor:
          "a branch other people have already pulled never gets its history rewritten",
        kind: "correction",
        lesson:
          "History on a branch other people have pulled is never rewritten; a mistake on it is corrected by a new commit that undoes it, so nobody's checkout is invalidated.",
        concepts: [
          "shared branch",
          "do not rewrite history",
          "add a commit that reverses the mistake",
          "other people have already pulled it",
        ],
        domain: "version-control-hygiene",
        position: "opening",
        form: "hard-never",
      },
    ],
    distractors: [
      {
        id: "branch-name",
        fact: "The shared branch here is called trunk.",
        concepts: ["trunk", "branch name"],
      },
      {
        id: "commit-sha",
        fact: "The bad commit is 9f1c2ab.",
        concepts: ["9f1c2ab", "commit id"],
      },
    ],
    turns: [
      {
        role: "user",
        text: "Before you touch anything: a branch other people have already pulled never gets its history rewritten. If something wrong is on it, we add a commit that undoes it. Rewriting breaks every checkout that has the old commits and we spend the afternoon on that instead of the bug.",
      },
      { role: "user", text: "With that in mind: I committed a debug flag to the shared branch and it is still there." },
      {
        role: "assistant",
        text: "I will add a commit that removes the flag rather than editing the existing one.",
        tool: { name: "Bash", input: { command: "git log --oneline -3" }, result: "9f1c2ab enable debug flag" },
      },
      { role: "assistant", text: "Done. The flag is gone as of the new commit, and 9f1c2ab is untouched on trunk." },
      { role: "user", text: "That is what I wanted. Push it when the suite is green." },
    ],
    work: [
      { kind: "edit", file: "src/config/flags.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "formatting-never-inherits-the-machine",
    language: "en",
    labels: [
      {
        id: "explicit-locale",
        anchor:
          "every number, date and currency we format gets the locale passed in explicitly",
        kind: "correction",
        lesson:
          "Any formatting of a number, date or currency passes an explicit locale; the default follows whatever machine the process happens to run on and produces a different string in the pipeline than on a laptop.",
        concepts: [
          "pass an explicit locale",
          "the default comes from the machine",
          "number, date or currency formatting",
          "output differs between environments",
        ],
        domain: "locale-and-formatting",
        position: "middle",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "default-locale",
        fact: "The service pins en-GB as its default locale.",
        concepts: ["en-GB", "default locale"],
      },
    ],
    turns: [
      { role: "user", text: "The invoice total renders as 1.234,50 in one environment and 1,234.50 in another. Same code." },
      {
        role: "assistant",
        text: "The formatter is called with no locale, so it takes the process default, and the two machines have different ones.",
        tool: READ("src/invoice/render.ts", "return amount.toLocaleString()"),
      },
      {
        role: "user",
        text: "Then fix it here and take the general point with you: from here on every number, date and currency we format gets the locale passed in explicitly. Never let it fall back to the machine. It is the kind of bug that only shows up once the output is in front of a customer.",
      },
      {
        role: "assistant",
        text: "The renderer now takes the locale from the request context and passes it to every formatter call. I also added a test that asserts the same input formats identically regardless of the process default. The service pins en-GB when the request carries none.",
        tool: { name: "Edit", input: { file_path: "src/invoice/render.ts" }, result: "3 edits applied" },
      },
    ],
    work: [
      { kind: "edit", file: "src/invoice/render.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "a-retry-needs-a-key-and-a-ceiling",
    language: "en",
    labels: [
      {
        id: "idempotency-key",
        anchor:
          "We never retry a write unless the request carries an idempotency key",
        kind: "correction",
        lesson:
          "A write is only retried when the request carries an idempotency key the receiver deduplicates on; without one a retry is a second write and the caller cannot tell.",
        concepts: [
          "retrying a write",
          "idempotency key",
          "receiver deduplicates on it",
          "otherwise the retry writes twice",
        ],
        domain: "retry-semantics",
        position: "middle",
        form: "hard-never",
      },
      {
        id: "retry-ceiling",
        anchor:
          "a retry loop always has a ceiling and a wait that grows",
        kind: "procedure",
        lesson:
          "Every retry loop is written with a bounded attempt count and a growing wait between attempts, and gives up into a recorded failure rather than looping until something else times out.",
        concepts: [
          "bounded number of attempts",
          "growing wait between attempts",
          "give up explicitly",
          "record the final failure",
        ],
        domain: "retry-shape",
        position: "closing",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "attempt-count",
        fact: "This client retries five times.",
        concepts: ["five attempts", "attempt count"],
      },
      {
        id: "header-name",
        fact: "The key travels in a header called X-Request-Key.",
        concepts: ["X-Request-Key", "header name"],
      },
    ],
    turns: [
      { role: "user", text: "The payout client gives up on the first timeout. Add a retry." },
      {
        role: "assistant",
        text: "I wrapped the call in a loop that retries on a timeout.",
        tool: { name: "Edit", input: { file_path: "src/payout/client.ts" }, result: "1 edit applied" },
      },
      {
        role: "user",
        text: "Not like that. We never retry a write unless the request carries an idempotency key that the other side deduplicates on. A timeout does not tell you the write did not land, so a blind retry is a second payout and the caller has no way to know.",
      },
      { role: "assistant", text: "The key goes in X-Request-Key, generated once per logical payout and reused across attempts." },
      {
        role: "user",
        text: "Yes. And while you are in there: a retry loop always has a ceiling and a wait that grows, and when it runs out it fails loudly and we record it. Never a loop that keeps going until something further up times out instead.",
      },
      {
        role: "assistant",
        text: "Five attempts, doubling wait, and the exhausted case raises with the attempt count and the last error attached so it shows up in the failure record rather than as a stuck request.",
        tool: { name: "Edit", input: { file_path: "src/payout/client.ts" }, result: "2 edits applied" },
      },
    ],
    work: [
      { kind: "edit", file: "src/payout/client.ts" },
      { kind: "bash-fail", command: "npm test", error: "1 failing: payout client retried without a key" },
      { kind: "edit", file: "src/payout/client.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "instants-are-stored-as-instants",
    language: "tr",
    labels: [
      {
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
    ],
    distractors: [
      {
        id: "display-zone",
        fact: "The web layer displays in Europe/Istanbul.",
        concepts: ["Europe/Istanbul", "display zone"],
      },
      {
        id: "column-type",
        fact: "The column is timestamptz.",
        concepts: ["timestamptz", "column type"],
      },
    ],
    turns: [
      { role: "user", text: "Sipariş tarihleri raporda bir saat kaymış görünüyor. Bakabilir misin?" },
      {
        role: "assistant",
        text: "The order timestamp is written after converting to the local zone, so the stored value already carries an offset that is lost.",
        tool: READ("src/order/repository.ts", "createdAt: toLocalTime(now())"),
      },
      {
        role: "user",
        text: "Veritabanına asla yerel saat yazmayız. Her an UTC olarak saklanır ve UTC olarak dolaşır; yerel saate çevirmek yalnızca ekranda, gösterildiği yerde olur. Yerel saat yazılan bir kolonu geri okurken hangi ofsetle yazıldığını bilemezsin, yaz saati geçişinde aynı değer iki farklı ana denk gelir.",
      },
      {
        role: "assistant",
        text: "The repository now writes the instant unconverted and the report renders it in the viewer's zone. The column is timestamptz and the web layer displays Europe/Istanbul.",
        tool: { name: "Edit", input: { file_path: "src/order/repository.ts" }, result: "2 edits applied" },
      },
      { role: "user", text: "Testi de ekle, bir kere daha kaymasın." },
      { role: "assistant", text: "Added a test that stores an instant during the spring transition and asserts it reads back identical." },
    ],
    work: [
      { kind: "edit", file: "src/order/repository.ts" },
      { kind: "bash-fail", command: "npm test", error: "1 failing: order timestamp differs by 3600 seconds" },
      { kind: "edit", file: "test/order.spec.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "a-log-line-lists-what-it-carries",
    language: "tr",
    labels: [
      {
        id: "log-allow-list",
        anchor:
          "Bir log satırına asla isteğin ya da yanıtın tamamını basmayız.",
        kind: "correction",
        lesson:
          "A log line never dumps a whole request or response object; each site names the fields it is allowed to record, so a field added later is never logged by accident.",
        concepts: [
          "do not log the whole object",
          "name the fields explicitly",
          "an allow list, not a deny list",
          "a new field is not logged by default",
        ],
        domain: "logging-discipline",
        position: "closing",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "logger-name",
        fact: "The logger is set up in src/log/index.ts.",
        concepts: ["src/log/index.ts", "logger setup"],
      },
    ],
    turns: [
      { role: "user", text: "Ödeme isteğinin loglarını genişletmek istiyorum, hata ayıklaması zor oluyor." },
      {
        role: "assistant",
        text: "I logged the full request body at the entry point, which gives every field at once.",
        tool: { name: "Edit", input: { file_path: "src/payment/handler.ts" }, result: "1 edit applied" },
      },
      {
        role: "user",
        text: "Bunu geri al. Bir log satırına asla isteğin ya da yanıtın tamamını basmayız. Her log çağrısı hangi alanları yazacağını tek tek sayar. Sebebi şu: yarın o gövdeye yeni bir alan eklenince, kimse log satırına bakmadığı hâlde o alan da loglara akmaya başlar. İzin listesi yazarız, yasak listesi yazmayız.",
      },
      {
        role: "assistant",
        text: "Rolled back and replaced with a named field list at the call site: the amount, the currency and the correlation id, nothing else. A field added to the body later will not appear until someone adds it here. The logger itself is set up in src/log/index.ts.",
        tool: { name: "Edit", input: { file_path: "src/payment/handler.ts" }, result: "2 edits applied" },
      },
    ],
    work: [
      { kind: "edit", file: "src/payment/handler.ts" },
      { kind: "bash-ok", command: "npm run lint" },
    ],
  },

  {
    id: "the-column-stays-until-nothing-reads-it",
    language: "en",
    labels: [
      {
        id: "drop-after-readers",
        anchor:
          "Think about what happens if we roll this release back on Friday evening.",
        kind: "correction",
        lesson:
          "A column is not dropped in the release that stops writing it: the write stops first, the release is allowed to settle so a rollback still has its data, and the drop follows separately once nothing reads it.",
        concepts: [
          "stop writing first",
          "do not drop in the same release",
          "a rollback still needs the data",
          "drop later once no reader is left",
        ],
        domain: "destructive-schema-change",
        position: "middle",
        form: "implicit",
      },
    ],
    distractors: [
      {
        id: "old-column",
        fact: "The column being retired is legacy_status.",
        concepts: ["legacy_status", "column name"],
      },
      {
        id: "row-count",
        fact: "The table has about four million rows.",
        concepts: ["four million rows", "table size"],
      },
    ],
    turns: [
      { role: "user", text: "We moved off legacy_status last sprint. Clean it up." },
      {
        role: "assistant",
        text: "I removed the remaining writes and added a migration that drops the column, both in this branch.",
        tool: { name: "Write", input: { file_path: "db/migrations/0051_drop_legacy_status.sql" }, result: "written" },
      },
      { role: "user", text: "Take the drop back out." },
      { role: "assistant", text: "Should it go in a follow-up branch instead?" },
      { role: "user", text: "Think about what happens if we roll this release back on Friday evening." },
      { role: "assistant", text: "The rolled-back code writes the column again, but the data written in between is gone, and so is the column." },
      { role: "user", text: "So what is the order?" },
      {
        role: "assistant",
        text: "Stop the writes and ship that alone, leave it running long enough that a rollback is no longer on the table, then drop the column in its own release once nothing reads it. I moved the migration out; the table is around four million rows so the drop itself will want a quiet window.",
      },
      { role: "user", text: "Right. Do that." },
    ],
    work: [
      { kind: "edit", file: "src/status/writer.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "waiting-without-a-deadline-is-a-hang",
    language: "en",
    labels: [
      {
        id: "deadline-on-wait",
        anchor:
          "nothing in this codebase waits on the outside world without a deadline",
        kind: "correction",
        lesson:
          "Every wait on something outside the process carries its own deadline; a call with no deadline does not fail, it hangs, and the failure surfaces somewhere unrelated.",
        concepts: [
          "every outbound wait has a deadline",
          "no deadline means a hang rather than an error",
          "the failure appears somewhere else",
          "set it at the call site",
        ],
        domain: "timeouts",
        position: "repeated",
        form: "hard-never",
      },
    ],
    distractors: [
      {
        id: "timeout-value",
        fact: "The queue consumer uses a thirty second deadline.",
        concepts: ["thirty seconds", "deadline value"],
      },
    ],
    turns: [
      {
        role: "user",
        text: "Before we start: nothing in this codebase waits on the outside world without a deadline. Not a request, not a lock, not a queue read. A wait without one does not fail, it hangs, and then you debug a timeout three layers away from the thing that actually stopped.",
      },
      { role: "user", text: "The consumer stops processing after a few hours and the process stays up. Have a look." },
      {
        role: "assistant",
        text: "The read from the queue is issued with no deadline, so once the connection goes half-open the loop never returns.",
        tool: READ("src/consumer/loop.ts", "const message = await queue.receive()"),
      },
      { role: "assistant", text: "I gave the receive call a thirty second deadline and the loop re-establishes the connection when it expires." },
      { role: "user", text: "Check the rest of that file too. Same rule everywhere: every wait on anything outside the process gets its own deadline, no exceptions." },
      {
        role: "assistant",
        text: "Two more unbounded waits in the same file, the lock acquisition and the acknowledgement write. Both now carry deadlines and the suite covers the expiry path.",
        tool: { name: "Edit", input: { file_path: "src/consumer/loop.ts" }, result: "3 edits applied" },
      },
    ],
    work: [
      { kind: "edit", file: "src/consumer/loop.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "configuration-is-read-once-into-a-shape",
    language: "en",
    labels: [
      {
        id: "config-once",
        anchor:
          "configuration is read once, at startup, into a typed object",
        kind: "correction",
        lesson:
          "A process resolves every setting in one place before it serves anything, checks each against its declared type, and refuses to start when one is missing or malformed; code further down the call path never consults the environment for itself.",
        concepts: [
          "read configuration once at startup",
          "into a typed object",
          "fail immediately when a value is missing",
          "call sites never read the environment",
        ],
        domain: "configuration-loading",
        position: "opening",
        form: "hard-never",
      },
    ],
    distractors: [
      {
        id: "config-path",
        fact: "The loader is src/config/load.ts.",
        concepts: ["src/config/load.ts", "loader path"],
      },
      {
        id: "var-count",
        fact: "There are nineteen variables today.",
        concepts: ["nineteen variables", "how many"],
      },
    ],
    turns: [
      {
        role: "user",
        // Under the recorder's 600-character line, so it IS recorded as a prompt, and
        // oldest in a session whose newer turns exhaust the user's share of the slice
        // budget, so it is NOT in the slice. That pairing is the whole point of this
        // fixture: it is the one case that separates "the model did not find the lesson"
        // from "the lesson never reached the model", and the corpus test asserts it.
        text: "One rule before anything else, because it comes up constantly: configuration is read once, at startup, into a typed object, and that read fails on the spot if anything is missing or the wrong shape. Nothing deeper in the code reaches for the environment itself. A service that starts fine and then dies at two in the morning on a value nobody set is the thing this prevents. Either a process has everything it needs before it serves anything, or it refuses to start. There is no third state where it runs for six hours and then does not.",
      },
      ...longErrandTurns([...Array(23).fill(1150), 700]),
      { role: "user", text: "Now the actual job: the worker needs the new outbound base address." },
      {
        role: "assistant",
        text: "Added it to the startup config object with a required string check, and the worker takes it from there. Nineteen variables now; the loader is src/config/load.ts.",
        tool: { name: "Edit", input: { file_path: "src/config/load.ts" }, result: "2 edits applied" },
      },
      { role: "user", text: "Good. Does it fail at boot when it is absent?" },
      { role: "assistant", text: "Yes, the process exits during the config read with the variable named in the message." },
    ],
    work: [
      { kind: "edit", file: "src/config/load.ts" },
      { kind: "bash-ok", command: "npm test" },
      { kind: "edit", file: "src/worker/outbound.ts" },
    ],
  },

  {
    id: "a-flag-is-removed-by-the-person-who-added-it",
    language: "en",
    labels: [
      {
        id: "flag-removal",
        anchor:
          "when we add a feature flag we schedule its removal in the same breath",
        kind: "correction",
        lesson:
          "A feature flag is created with the change that removes it already scheduled; once the flag is fully on, the branch it guards and the flag itself come out in the same piece of work.",
        concepts: [
          "schedule the removal when the flag is added",
          "once fully on, take the flag out",
          "remove the guarded branch with it",
          "the author removes it",
        ],
        domain: "feature-flags",
        position: "opening",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "flag-count",
        fact: "There are thirty-one flags in the file, eleven of them fully on.",
        concepts: ["thirty-one flags", "eleven fully on"],
      },
    ],
    turns: [
      {
        role: "user",
        text: "Something to carry with you from here on: when we add a feature flag we schedule its removal in the same breath. The moment it is fully on, the flag and the branch it was guarding come out together, and the person who added it is the one who takes it out. Otherwise the file becomes a museum and nobody dares delete anything.",
      },
      ...errandTurns(45),
      { role: "user", text: "Add a flag for the new pricing path, default off." },
      {
        role: "assistant",
        text: "Added, default off, and the removal is on the board already so it does not outlive the rollout. The file has thirty-one flags now, eleven of them fully on.",
        tool: { name: "Edit", input: { file_path: "src/flags.ts" }, result: "1 edit applied" },
      },
      { role: "user", text: "Fine. Ship it." },
    ],
    work: [
      { kind: "edit", file: "src/flags.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "an-afternoon-of-small-errands",
    language: "en",
    labels: [],
    distractors: [
      {
        id: "helper-name",
        fact: "The pagination constant is called PAGE_SIZE and is 50.",
        concepts: ["PAGE_SIZE", "50"],
      },
      {
        id: "lint-rule",
        fact: "The lint rule that fired is no-unused-vars.",
        concepts: ["no-unused-vars", "lint rule"],
      },
      {
        id: "file-count",
        fact: "Four files changed.",
        concepts: ["four files", "how many changed"],
      },
    ],
    turns: [
      { role: "user", text: "Bit of tidying today, nothing structural." },
      ...errandTurns(6),
      { role: "user", text: "That is everything. Anything the linter still complains about?" },
      {
        role: "assistant",
        text: "One no-unused-vars left in the worker entrypoint, now removed. Four files changed in total; the pagination constant is PAGE_SIZE and reads 50.",
        tool: { name: "Bash", input: { command: "npm run lint" }, result: "0 problems" },
      },
      { role: "user", text: "Good enough. I will pick the refactor up tomorrow." },
    ],
    work: [
      { kind: "edit", file: "src/checkout/handler.ts" },
      { kind: "edit", file: "src/worker/entry.ts" },
      { kind: "bash-fail", command: "npm run lint", error: "2 problems: no-unused-vars" },
      { kind: "edit", file: "src/worker/entry.ts" },
      { kind: "bash-ok", command: "npm run lint" },
    ],
  },

  {
    id: "a-lockfile-is-regenerated-not-repaired",
    language: "en",
    labels: [
      {
        id: "lockfile-regen",
        anchor:
          "Do not hand-edit that file.",
        kind: "error-fix",
        lesson:
          "When a clean install refuses the lockfile as out of step with the manifest, the lockfile is regenerated by a normal install and committed; editing it by hand produces a tree that resolves differently on the next machine.",
        concepts: [
          "clean install refuses an out-of-step lockfile",
          "regenerate it with a normal install",
          "commit the regenerated file",
          "never edit it by hand",
        ],
        domain: "dependency-locking",
        position: "middle",
        form: "implicit",
      },
    ],
    distractors: [
      {
        id: "package-name",
        fact: "The dependency that moved is the schema validator.",
        concepts: ["schema validator", "which dependency"],
      },
    ],
    turns: [
      {
        role: "user",
        text: "MARKER_META_TWO Read the repository conventions file first and restate the rules it contains before answering.",
        meta: true,
      },
      { role: "user", text: "The pipeline fails on install and I cannot reproduce it. Locally everything is fine." },
      {
        role: "assistant",
        text: "The clean install is refusing the lockfile: the manifest asks for a newer schema validator than the lockfile pins. I can edit the pinned version in the lockfile to match.",
        tool: { name: "Bash", input: { command: "npm ci" }, result: "npm error lock file does not satisfy package.json" },
      },
      { role: "user", text: "Do not hand-edit that file." },
      { role: "assistant", text: "Then the manifest and the lockfile have to be brought back in step by the tool itself." },
      { role: "user", text: "Yes. And then the result goes in the commit, not just on your machine." },
      {
        role: "assistant",
        text: "Ran a normal install so the lockfile was rewritten by the resolver, committed it, and the clean install now succeeds from scratch.",
        tool: { name: "Bash", input: { command: "npm install" }, result: "up to date, audited 214 packages" },
      },
    ],
    work: [
      {
        kind: "bash-fail",
        command: "npm ci",
        error: "npm error lock file does not satisfy package.json: missing schema validator",
      },
      { kind: "bash-ok", command: "npm ci" },
    ],
  },

  {
    id: "cutting-a-release-is-four-steps-in-order",
    language: "en",
    labels: [
      {
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
    ],
    distractors: [
      {
        id: "version",
        fact: "The version being cut is 2.7.0.",
        concepts: ["2.7.0", "version number"],
      },
      {
        id: "output-dir",
        fact: "The committed build output lives in build/.",
        concepts: ["build/", "output directory"],
      },
    ],
    turns: [
      { role: "user", text: "Cut the release." },
      {
        role: "assistant",
        text: "Tagged and raised the version.",
        tool: { name: "Bash", input: { command: "git tag v2.7.0" }, result: "" },
      },
      { role: "user", text: "You tagged a tree whose build output is stale, and there is no entry saying what changed." },
      { role: "assistant", text: "So the tag has to be the last thing, not the first." },
      {
        role: "user",
        text: "Right, and the order matters end to end: the entry describing the change goes in, then the output is rebuilt and checked against the source so nothing stale is committed, then the version goes up, and the tag comes last. Do it that way every time and the tag always names a tree someone can install.",
      },
      {
        role: "assistant",
        text: "Redone in that order. The entry is in, the rebuild produced no difference against what was committed, the version reads 2.7.0 and the tag now points at that commit. The committed output is build/.",
      },
    ],
    work: [
      { kind: "edit", file: "CHANGELOG.md" },
      { kind: "bash-fail", command: "npm run verify", error: "build output differs from source in 2 files" },
      { kind: "bash-ok", command: "npm run verify" },
    ],
  },

  {
    id: "a-test-name-states-the-behaviour",
    language: "en",
    labels: [
      {
        id: "behaviour-naming",
        anchor:
          "a test says what the behaviour is and under what condition it holds",
        kind: "correction",
        lesson:
          "A test is named after the behaviour it pins and the condition it holds under, not after the function it calls, so a failure line says what broke without anyone opening the file.",
        concepts: [
          "name the test after the behaviour",
          "include the condition",
          "not after the function under test",
          "the failure line is readable on its own",
        ],
        domain: "test-naming",
        position: "middle",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "test-count",
        fact: "That file has twenty-two tests.",
        concepts: ["twenty-two tests", "how many"],
      },
    ],
    turns: [
      { role: "user", text: "Add coverage for the discount rules." },
      {
        role: "assistant",
        text: "Added three tests: applyDiscount case 1, applyDiscount case 2, applyDiscount case 3.",
        tool: { name: "Write", input: { file_path: "test/discount.spec.ts" }, result: "written" },
      },
      {
        role: "user",
        text: "Rename those. Going forward a test says what the behaviour is and under what condition it holds, never the name of the function it happens to call. When one of these fails in the pipeline I want the failing line alone to tell me what broke, without opening the file to find out which case 2 was.",
      },
      {
        role: "assistant",
        text: "Renamed to state the rule and the condition each one pins: no discount below the threshold, the capped amount at the ceiling, and the rejection when two offers collide. That file is up to twenty-two tests.",
        tool: { name: "Edit", input: { file_path: "test/discount.spec.ts" }, result: "3 edits applied" },
      },
    ],
    work: [
      { kind: "edit", file: "test/discount.spec.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "a-test-waits-for-the-condition-not-the-clock",
    language: "en",
    labels: [
      {
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
    ],
    distractors: [
      {
        id: "sleep-value",
        fact: "The sleep in there was two seconds.",
        concepts: ["two seconds", "sleep length"],
      },
    ],
    turns: [
      { role: "user", text: "The consumer test fails maybe one run in ten on the shared machine." },
      {
        role: "assistant",
        text: "It sleeps two seconds and then asserts the message was handled. Shall I raise the sleep to five?",
        tool: READ("test/consumer.spec.ts", "await sleep(2000)"),
      },
      {
        role: "user",
        text: "No. We never sleep a fixed amount in a test to let something catch up. Poll for the thing you are actually waiting for and give the poll a deadline. A sleep is wasted time on a fast machine and still too short on a loaded one, so raising it just moves the flake somewhere you will not look for a month.",
      },
      {
        role: "assistant",
        text: "Replaced with a poll on the handled count, short interval, deadline on the whole wait, and the failure message says which condition never became true. The file no longer imports the sleep helper.",
        tool: { name: "Edit", input: { file_path: "test/consumer.spec.ts" }, result: "2 edits applied" },
      },
      { role: "user", text: "Run it thirty times." },
      { role: "assistant", text: "Thirty for thirty, and the suite is about four seconds faster overall." },
    ],
    work: [
      { kind: "bash-fail", command: "npm test", error: "1 failing: expected handled count 1, got 0" },
      { kind: "edit", file: "test/consumer.spec.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "the-image-carries-what-the-code-assumes",
    language: "en",
    labels: [
      {
        id: "image-carries-data",
        anchor:
          "Skipping it means we ship a build that cannot do the thing the test was checking.",
        kind: "error-fix",
        lesson:
          "When something passes locally and fails in the pipeline with a missing reference table, the runtime image is missing data the code assumes is present; install it in the image rather than working around its absence in code.",
        concepts: [
          "passes locally, fails in the pipeline",
          "the image lacks data the code assumes",
          "install it in the image",
          "do not code around the missing data",
        ],
        domain: "runtime-image-contents",
        position: "middle",
        form: "implicit",
      },
    ],
    distractors: [
      {
        id: "zone-name",
        fact: "The zone the test asks for is Pacific/Auckland.",
        concepts: ["Pacific/Auckland", "zone name"],
      },
      {
        id: "base-image",
        fact: "The runtime image is the slim variant.",
        concepts: ["slim variant", "base image"],
      },
    ],
    turns: [
      { role: "user", text: "One test fails only in the pipeline. Unknown time zone, but the zone exists." },
      {
        role: "assistant",
        text: "The zone database is not in the runtime image, so the lookup fails there and succeeds on your machine. I can skip the test when the zone is unavailable.",
        tool: { name: "Bash", input: { command: "npm test" }, result: "Error: unknown time zone Pacific/Auckland" },
      },
      { role: "user", text: "Skipping it means we ship a build that cannot do the thing the test was checking." },
      { role: "assistant", text: "So the image has to carry the data the code assumes, not the test bend around it missing." },
      {
        role: "user",
        text: "Exactly that. Put it in the image.",
      },
      {
        role: "assistant",
        text: "Added the zone data package to the runtime layer and the test passes unchanged in both places. The image is the slim variant, which is why it was absent.",
        tool: { name: "Edit", input: { file_path: "Dockerfile" }, result: "1 edit applied" },
      },
    ],
    work: [
      { kind: "bash-fail", command: "npm test", error: "Error: unknown time zone Pacific/Auckland" },
      { kind: "edit", file: "Dockerfile" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "rotating-a-credential-without-a-gap",
    language: "en",
    labels: [
      {
        id: "rotation-order",
        anchor:
          "the new value is issued first, then every reader is deployed so it accepts both",
        kind: "procedure",
        lesson:
          "A credential is rotated by accepting both values before either side switches: issue the new one, deploy every reader so it accepts old and new, move the writers over, confirm nothing uses the old one, and revoke it last.",
        concepts: [
          "issue the new credential first",
          "readers accept both values",
          "move writers over after that",
          "revoke the old one only once nothing uses it",
        ],
        domain: "credential-rotation",
        position: "closing",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "reader-count",
        fact: "Six services read that credential.",
        concepts: ["six services", "how many readers"],
      },
    ],
    turns: [
      { role: "user", text: "The signing credential needs rotating this week." },
      { role: "assistant", text: "I can issue a new one, swap it in the writer and revoke the old one in the same change." },
      { role: "user", text: "Six services read that thing. What happens to the five you did not deploy yet?" },
      { role: "assistant", text: "They are still verifying against the old value, so they reject everything signed with the new one." },
      {
        role: "user",
        text: "So the shape is always the same and it is worth writing down: the new value is issued first, then every reader is deployed so it accepts both, then the writers move over, then you check nothing is still presenting the old one, and revoking it is the last step. Never revoke on the same day you issue.",
      },
      {
        role: "assistant",
        text: "Sequenced that way, one deployment per stage, with the check between the writer move and the revoke reading from the access records rather than from anyone's memory.",
        tool: { name: "Edit", input: { file_path: "docs/runbook-rotation.md" }, result: "written" },
      },
    ],
    work: [
      { kind: "edit", file: "src/signing/verify.ts" },
      { kind: "bash-ok", command: "npm test" },
      { kind: "edit", file: "docs/runbook-rotation.md" },
    ],
  },

  {
    id: "one-reason-to-change-per-review",
    language: "en",
    labels: [
      {
        id: "single-reason-pr",
        anchor:
          "one reason to change per review",
        kind: "correction",
        lesson:
          "A review carries one reason to change; unrelated cleanup found along the way goes out separately, because a reviewer who cannot tell the fix from the tidying approves both without reading either.",
        concepts: [
          "one reason to change per review",
          "unrelated cleanup goes separately",
          "the reviewer can tell fix from tidying",
          "mixing them means neither is read",
        ],
        domain: "review-scope",
        position: "closing",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "diff-size",
        fact: "The branch touched forty-one files.",
        concepts: ["forty-one files", "diff size"],
      },
    ],
    turns: [
      { role: "user", text: "Fix the rounding bug in the totals." },
      {
        role: "assistant",
        text: "Fixed the rounding, and while I was in there I reformatted the module, renamed two helpers and removed a dead branch. Forty-one files changed.",
        tool: { name: "Edit", input: { file_path: "src/totals.ts" }, result: "1 edit applied" },
      },
      { role: "user", text: "The rounding fix is four lines and it is now invisible." },
      { role: "assistant", text: "I should put the reformatting and the renames on their own branch." },
      {
        role: "user",
        text: "Yes, and as a standing rule: one reason to change per review. Whatever else you notice goes out on its own. A reviewer who cannot tell which lines are the fix ends up approving the whole thing without reading any of it, and that is how the real change goes in unreviewed.",
      },
      { role: "assistant", text: "Split. The rounding fix is four lines with its test; everything else is a second branch." },
    ],
    work: [
      { kind: "edit", file: "src/totals.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "a-cache-key-names-the-shape-it-holds",
    language: "mixed",
    labels: [
      {
        id: "versioned-cache-key",
        anchor:
          "Önbellek anahtarı, tuttuğu değerin şeklinin sürümünü taşımak zorunda.",
        kind: "correction",
        lesson:
          "A cache key includes a version for the shape of the value it holds, so a deploy that changes that shape misses instead of handing old bytes to new code.",
        concepts: [
          "the cache key carries a shape version",
          "raise it when the shape changes",
          "a deploy then misses instead of reading stale bytes",
          "no manual cache clearing",
        ],
        domain: "cache-invalidation",
        position: "middle",
        form: "hard-never",
      },
    ],
    distractors: [
      {
        id: "key-prefix",
        fact: "The keys are prefixed catalog:.",
        concepts: ["catalog:", "key prefix"],
      },
      {
        id: "ttl",
        fact: "Entries live for ten minutes.",
        concepts: ["ten minutes", "how long entries live"],
      },
    ],
    turns: [
      { role: "user", text: "After the last deploy the catalog endpoint returned objects missing the new field for about ten minutes." },
      {
        role: "assistant",
        text: "The cached value predates the field and the key did not change, so the new code read the old shape until the entries expired.",
        tool: READ("src/catalog/cache.ts", "const key = `catalog:${id}`"),
      },
      {
        role: "user",
        text: "Önbellek anahtarı, tuttuğu değerin şeklinin sürümünü taşımak zorunda. Şekil değişince sürüm artar, eski girdiler kendiliğinden ıskalanır. We never clear a cache by hand to fix a deploy; if that is the plan, the key is wrong.",
      },
      {
        role: "assistant",
        text: "The key now carries a shape version alongside the identifier and the constant sits next to the type it describes, so changing the type without raising it is visible in the same diff. Prefix is still catalog: and entries live ten minutes.",
        tool: { name: "Edit", input: { file_path: "src/catalog/cache.ts" }, result: "2 edits applied" },
      },
      { role: "user", text: "Testi de yaz, eski şekil yeni koda gelmesin." },
      { role: "assistant", text: "Added a test that writes an entry at the old version and asserts the new reader misses it." },
    ],
    work: [
      { kind: "edit", file: "src/catalog/cache.ts" },
      { kind: "edit", file: "test/catalog-cache.spec.ts" },
      { kind: "bash-ok", command: "npm test" },
    ],
  },

  {
    id: "the-build-agrees-with-the-filesystem-that-cares",
    language: "en",
    labels: [
      {
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
    ],
    distractors: [
      {
        id: "module-name",
        fact: "The module is OrderTotals.ts, imported as orderTotals.",
        concepts: ["OrderTotals.ts", "which module"],
      },
    ],
    turns: [
      { role: "user", text: "Build is red in the pipeline, green here. Cannot find module, but the file is right there." },
      {
        role: "assistant",
        text: "The import says orderTotals and the file is OrderTotals.ts. Your filesystem does not care about that and the pipeline's does.",
        tool: { name: "Bash", input: { command: "npm run build" }, result: "error TS2307: Cannot find module './orderTotals'" },
      },
      { role: "user", text: "Fix the import. And I do not want to find this out from the pipeline again." },
      { role: "assistant", text: "So the check has to fail on this machine as well, where the filesystem will not." },
      {
        role: "user",
        text: "That is the part that matters.",
      },
      {
        role: "assistant",
        text: "Corrected the spelling and turned on the compiler's consistent-casing check, which now fails locally on exactly this mistake. Verified by reintroducing it once.",
        tool: { name: "Edit", input: { file_path: "tsconfig.json" }, result: "1 edit applied" },
      },
    ],
    work: [
      {
        kind: "bash-fail",
        command: "npm run build",
        error: "error TS2307: Cannot find module './orderTotals' or its corresponding type declarations",
      },
      { kind: "edit", file: "src/report/index.ts" },
      { kind: "bash-ok", command: "npm run build" },
    ],
  },

  {
    id: "a-new-nullable-column-owes-a-plan-for-the-old-rows",
    language: "en",
    labels: [
      {
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
      {
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
    ],
    distractors: [
      {
        id: "default-value",
        fact: "The new column defaults to null.",
        concepts: ["defaults to null", "column default"],
      },
      {
        id: "batch-size",
        fact: "The backfill runs in batches of two thousand.",
        concepts: ["two thousand", "batch size"],
      },
    ],
    turns: [
      { role: "user", text: "Add a risk band to the customer record." },
      {
        role: "assistant",
        text: "Added the column, nullable, defaulting to null.",
        tool: { name: "Write", input: { file_path: "db/migrations/0063_add_risk_band.sql" }, result: "written" },
      },
      {
        role: "user",
        text: "And the rows that already exist? A column never goes onto an existing table without us deciding what the old rows say. Either we backfill them, in batches, or we write down why an absent value means something real to every reader. Otherwise every consumer invents its own answer and they disagree.",
      },
      { role: "assistant", text: "Backfill, then. The band is derivable from the existing history." },
      {
        role: "assistant",
        text: "The backfill failed: canceling statement due to lock timeout.",
        tool: { name: "Bash", input: { command: "npm run migrate" }, result: "ERROR: canceling statement due to lock timeout" },
      },
      { role: "user", text: "It tried to take the whole table at once, did it." },
      { role: "assistant", text: "Yes. And waiting longer just means more writers queued behind it." },
      { role: "user", text: "So do not wait longer." },
      {
        role: "assistant",
        text: "Set a short explicit lock timeout so it gives up immediately rather than holding a queue, and ran the backfill in batches of two thousand with a retry on the timeout. It completed with no blocked writers.",
        tool: { name: "Edit", input: { file_path: "db/migrations/0063_add_risk_band.sql" }, result: "2 edits applied" },
      },
    ],
    work: [
      { kind: "edit", file: "db/migrations/0063_add_risk_band.sql" },
      { kind: "bash-fail", command: "npm run migrate", error: "ERROR: canceling statement due to lock timeout" },
      { kind: "edit", file: "db/migrations/0063_add_risk_band.sql" },
      { kind: "bash-ok", command: "npm run migrate" },
    ],
  },

  {
    id: "adding-a-consumer-is-the-same-five-steps",
    language: "en",
    labels: [
      {
        id: "consumer-steps",
        anchor:
          "the failure destination is declared first, then the handler is registered",
        kind: "procedure",
        lesson:
          "A new queue consumer is added in a fixed order: declare its own failure destination, register the handler, make the handler tolerate the same message twice, publish one message by hand and watch it through, then turn on the schedule.",
        concepts: [
          "declare its own failure destination first",
          "register the handler",
          "make it safe to receive a message twice",
          "prove one message end to end before enabling",
        ],
        domain: "queue-consumer-setup",
        position: "closing",
        form: "soft-henceforth",
      },
    ],
    distractors: [
      {
        id: "queue-name",
        fact: "The queue is named invoice-events.",
        concepts: ["invoice-events", "queue name"],
      },
      {
        id: "consumer-count",
        fact: "This is the seventh consumer.",
        concepts: ["seventh", "how many consumers"],
      },
      {
        id: "prefetch",
        fact: "Prefetch is set to ten.",
        concepts: ["ten", "prefetch value"],
      },
    ],
    turns: [
      { role: "user", text: "We need a consumer on invoice-events that writes the settlement record." },
      {
        role: "assistant",
        text: "Registered the handler and enabled it on the schedule.",
        tool: { name: "Write", input: { file_path: "src/consumers/settlement.ts" }, result: "written" },
      },
      { role: "user", text: "Where do the messages it cannot handle go?" },
      { role: "assistant", text: "Nowhere yet. They would be redelivered forever." },
      { role: "user", text: "And if the same message arrives twice?" },
      { role: "assistant", text: "Two settlement records. Neither of those is acceptable." },
      {
        role: "user",
        text: "Then do it in the order we always do it, and keep the order: the failure destination is declared first, then the handler is registered, then the handler is made safe to receive the same message twice, then you publish one message by hand and follow it all the way through, and only after that does the schedule get turned on. Skipping the by-hand message is what makes the first incident a surprise.",
      },
      {
        role: "assistant",
        text: "Done in that order. Failure destination declared, handler registered, the write keyed so a repeat is a no-op, one message published and traced to a written record, and the schedule enabled last. It is the seventh consumer; prefetch is ten.",
      },
      { role: "user", text: "Good." },
    ],
    work: [
      { kind: "edit", file: "src/consumers/settlement.ts" },
      { kind: "bash-ok", command: "npm test" },
      { kind: "edit", file: "infra/queues.yaml" },
    ],
  },
];

/** The legible corpus the headline band was taken on: the rule is stated outright, the
 * slice fills 2% of its cap, and the existing-skill list is empty. */
export const TIER1_SESSIONS: CorpusSession[] = TIER1.map((s) => ({ ...s, tier: 1 }));

/**
 * Both tiers, in one list, because everything downstream looks a session up by id: the
 * metrics, the grader's donor map and the runner's selection. They are never POOLED -
 * `run.ts` bands each tier on its own - but they do share one namespace, and
 * `corpus.test.ts` asserts that ids and domains are unique across it. A tier-2 label that
 * reused a tier-1 domain would quietly make the shuffled-label control a hard question
 * instead of a wrong one.
 */
export const SESSIONS: CorpusSession[] = [...TIER1_SESSIONS, ...TIER2_SESSIONS];

export function sessionsInTier(tier: 1 | 2): CorpusSession[] {
  return SESSIONS.filter((s) => s.tier === tier);
}

/**
 * A derangement of the corpus that never pairs two lessons about the same subject. The
 * control asks the grader the real question with the wrong reference, and the answer has
 * to be no: same-domain pairs would make it a hard question instead of a wrong one, and a
 * non-zero result would then be honest rather than a grader fault.
 */
export function shuffledLabels(sessions: CorpusSession[]): Map<string, Label[]> {
  const withLabels = sessions.filter((s) => s.labels.length > 0);
  const map = new Map<string, Label[]>();
  for (let i = 0; i < withLabels.length; i++) {
    const source = withLabels[i]!;
    let offset = 1;
    let donor = withLabels[(i + offset) % withLabels.length]!;
    const domains = new Set(source.labels.map((l) => l.domain));
    while (
      offset < withLabels.length &&
      (donor.id === source.id || donor.labels.some((l) => domains.has(l.domain)))
    ) {
      offset += 1;
      donor = withLabels[(i + offset) % withLabels.length]!;
    }
    map.set(source.id, donor.labels);
  }
  return map;
}
