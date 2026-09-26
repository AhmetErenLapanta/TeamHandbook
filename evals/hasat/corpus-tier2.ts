// Tier 2: the same measurement, at production's density, with the two things tier 1 could
// not tell you.
//
// Tier 1's number is a ceiling and its own report says why: in 23 of its 24 sessions the
// developer states the rule outright, the slice that reaches the model fills 2% of its cap,
// and the existing-skill list is injected empty. Two of its conclusions were also
// unreadable by construction - `error-fix` and `implicit` named the same five labels, and
// the sieve's duplicate rule never fired because there was no existing skill to collide
// with.
//
// So this tier changes three things and nothing else:
//
//   - **the cross table is filled.** A voiced error-fix, an implicit procedure, an implicit
//     correction: the cells tier 1 left empty, so a later adjustment can tell which
//     attribute it moved.
//   - **the lesson is not stated.** Nine labels are `unstated`: the same mistake is
//     corrected twice on its own terms, or the developer reverts the same thing twice, or a
//     procedure is simply carried out in order, and NOBODY ever says "from here on". The
//     canonical sentence exists only in the label, which is the point - it is what a real
//     session looks like, and the half of the product's promise tier 1 could not reach.
//   - **the session is dense.** `noise.ts` fills the slice to roughly two thirds of its cap
//     with work that carries no lesson, the turn holding the lesson is a few percent of
//     what the developer said rather than 70% of it, and three to five existing skills are
//     injected - one of which, in three sessions, already covers the session's own lesson,
//     which is the only way the duplicate branch of the sieve gets exercised at all.
//
// What has NOT changed: everything is still invented, no real path or account name or
// repository appears, the canonical sentence still appears nowhere in the transcript, and
// the labels are still written before any model is asked anything.
//
// ONE audit of the labels happened after the pilot and before the measured runs, and it is
// declared here because it is a change to the TARGET rather than to the instrument. Seven
// concept lists carried a clause that was the lesson's RATIONALE rather than its content -
// "and it goes stale without anyone noticing", "the loss is silent rather than an error", "it
// has to be undone when the second use differs" - and the grader's rubric requires every
// listed concept to be present. A faithful statement of the rule does not have to carry its
// own justification, so those clauses were removed and one was replaced by the content clause
// it stood in for. The direction of the change is stated rather than hidden: it LOOSENS the
// target, so recall can only move up because of it. The rubric itself was not touched, and no
// label's canonical sentence changed.
import { noiseTurns } from "./noise.js";
import type { CorpusSession, Turn } from "./corpus.js";
import type { SkillSummary } from "../../src/lib/skill-index.js";

/**
 * Skills the developer is taken to have already, injected into the prompt as `listSkills`
 * would return them. None of them covers any lesson labelled in this tier - the three
 * sessions where one deliberately does carry it in their own list - because a skill that
 * accidentally covered a label would suppress it and the miss would be read as a model
 * failure.
 *
 * The descriptions are the shape a real one has, and they matter: what the model is shown
 * is the name and the description, and it is on that pair that it decides whether a lesson
 * it found is already covered.
 */
const SKILL_POOL: SkillSummary[] = [
  { name: "write-a-changelog-entry", description: "Use when a change needs a line in the changelog: which section it goes in and how the line is worded." },
  { name: "bump-a-dependency-safely", description: "Use when raising a dependency version: read the release notes, run the suite, and check what else pins it." },
  { name: "name-a-branch", description: "Use when starting a branch: the naming shape this project uses and what it is derived from." },
  { name: "write-a-commit-message", description: "Use when committing: the subject line's shape, what belongs in the body, and what belongs in the merge request instead." },
  { name: "profile-a-slow-endpoint", description: "Use when a route is slower than it should be: where to put the timers and how to read the result." },
  { name: "set-up-a-local-database", description: "Use when a fresh working copy needs a database: bring the container up, apply migrations, and check the connection." },
  { name: "triage-a-pager-alert", description: "Use when an alert fires: what to check first, what to write down, and when to escalate." },
  { name: "write-a-runbook-entry", description: "Use when an operational procedure needs writing down: the sections a runbook entry has and the level of detail." },
  { name: "paginate-a-listing-endpoint", description: "Use when a listing endpoint needs paging: the cursor shape, the page size default, and what the response carries." },
  { name: "document-an-api-change", description: "Use when a public response or route changes: where the documentation lives and which parts need an example." },
  { name: "read-a-flame-graph", description: "Use when a profile has been captured and needs interpreting: what the widths mean and which frames to ignore." },
  { name: "add-a-dashboard-panel", description: "Use when a new panel is needed: which dashboard it belongs on and how the query is written." },
];

/** A rotating window of the pool, so no two sessions carry the same list and every session
 * carries three to five. Deterministic: a corpus that differed between two builds would put
 * the difference into the measurement. */
function skills(start: number, count = 4): SkillSummary[] {
  return Array.from({ length: count }, (_, i) => SKILL_POOL[(start + i) % SKILL_POOL.length]!);
}

/** The same, plus the skill that already covers this session's lesson. The covering skill
 * is named as the harvest would most plausibly name that lesson itself, so the sieve's slug
 * comparison has a real chance of firing rather than a rigged one. */
function skillsCovering(start: number, covering: SkillSummary): SkillSummary[] {
  return [...skills(start, 3), covering];
}

/** Filler either side of the hand-written lesson turns. The second block continues the
 * first one's rotation rather than restarting it, so a session never repeats a shape. */
function around(theme: string, before: number, after: number, lesson: Turn[]): Turn[] {
  return [
    ...noiseTurns({ theme, exchanges: before }),
    ...lesson,
    ...noiseTurns({ theme, exchanges: after, offset: before }),
  ];
}

export const TIER2_SESSIONS: CorpusSession[] = [
  // ── the cross table's empty cells: a lesson the developer DOES state ──────
  //
  // error-fix × hard-never, error-fix × soft-henceforth, procedure × hard-never,
  // procedure × implicit, correction × implicit. Tier 1 had none of these five: all of its
  // error-fix labels were implicit and all of its procedures soft-voiced, so its
  // "error-fix 12/15" row and its "implicit 15/18" row were the same two labels twice.

  {
    id: "a-unit-test-that-reached-the-network",
    tier: 2,
    language: "en",
    existingSkills: skills(0),
    labels: [
      {
        id: "no-socket-in-unit-tests",
        kind: "error-fix",
        form: "hard-never",
        position: "middle",
        domain: "test-isolation-from-the-network",
        anchor: "A unit test never opens a socket. Not to a sandbox, not to localhost",
        lesson:
          "A unit test must not open a network connection: the code is written so the outbound call sits behind a seam the test replaces with a stub, and a test that needs a real connection is an integration test and lives with the others.",
        concepts: [
          "a unit test opens no network connection",
          "the outbound call sits behind a seam",
          "the test substitutes a stub at that seam",
          "a test that needs the real thing is an integration test",
        ],
      },
    ],
    distractors: [
      { id: "sandbox-host", fact: "The card sandbox answers at sandbox.example.invalid and rate-limits after sixty calls a minute.", concepts: ["sandbox host", "sixty calls a minute"] },
      { id: "suite-duration", fact: "The unit suite takes eleven seconds on this machine.", concepts: ["eleven seconds", "suite duration"] },
    ],
    turns: around("billing", 11, 12, [
      {
        role: "user",
        text: "The build has been red for two days on one test and everyone is ignoring it. Find out why it only fails there.",
      },
      {
        role: "assistant",
        text: "It fails because it makes a real call. The test for the charge path builds a client with no base address override, so the client falls back to its default, which is the sandbox at sandbox.example.invalid. On a developer machine that resolves and answers; on the build agent it does not, so the call times out after thirty seconds and the assertion never runs. The sandbox also rate-limits after sixty calls a minute, which is why the test is flaky rather than always red when it does run.",
        tool: { name: "Bash", input: { command: "npx vitest run src/billing/charge.test.ts" }, result: "FAIL src/billing/charge.test.ts > charges a card once\n  Error: connect ETIMEDOUT 203.0.113.9:443\n    at TCPConnectWrap.afterConnect" },
      },
      {
        role: "user",
        text: "A unit test never opens a socket. Not to a sandbox, not to localhost, not to anything. If the code cannot be tested without a connection then the code is wrong: put the outbound call behind a seam and hand the test a stub at that seam. If a test genuinely needs the real service then it is an integration test and it goes with the integration tests, where we already accept that it needs an environment.",
      },
      {
        role: "assistant",
        text: "Done that way. The charge path now takes the transport as an argument, the unit test passes a stub that records what it was asked for, and the sandbox call survives only in the integration suite, which already has the environment for it. The unit suite is eleven seconds on this machine and no longer touches the network at all.",
        tool: { name: "Bash", input: { command: "npx vitest run src/billing" }, result: "Test Files  4 passed (4)\n     Tests  37 passed (37)\n  Duration  11.02s" },
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npx vitest run src/billing/charge.test.ts", error: "Error: connect ETIMEDOUT" },
      { kind: "edit", file: "src/billing/charge.ts" },
      { kind: "edit", file: "src/billing/charge.test.ts" },
      { kind: "bash-ok", command: "npx vitest run src/billing/charge.test.ts" },
    ],
  },

  {
    id: "a-migration-that-could-not-be-undone",
    tier: 2,
    language: "en",
    existingSkills: skills(2),
    labels: [
      {
        id: "reversible-before-merge",
        kind: "error-fix",
        form: "hard-never",
        position: "middle",
        domain: "migration-reversibility",
        anchor: "we never merge a migration whose reverse has not been run",
        lesson:
          "A schema migration is not finished until its reverse has actually been executed against a copy of the real schema in the same run that applied it; a migration whose down path has only been written is treated as untested and does not merge.",
        concepts: [
          "the reverse of the migration is executed, not just written",
          "against a realistic copy of the schema",
          "in the same run that applies it",
          "an unexercised down path does not merge",
        ],
      },
    ],
    distractors: [
      { id: "migration-tool", fact: "Migrations run through the project's own runner in db/run.ts and are numbered sequentially.", concepts: ["db/run.ts", "sequential numbering"] },
      { id: "stuck-count", fact: "Three environments were left on the half-applied version for two hours.", concepts: ["three environments", "two hours"] },
    ],
    turns: around("contracts", 12, 11, [
      {
        role: "user",
        text: "The deploy stopped halfway through the migration last night and we could not go back. Walk me through what actually happened before we discuss the fix.",
      },
      {
        role: "assistant",
        text: "The migration did two things: it added the new column and then rewrote the existing rows in one statement. The rewrite failed on a row with a null the code did not expect, and the runner rolled back only the statement it was in, not the earlier one, so the column existed and the data did not. The down path in the file drops the column, but it assumes the rewrite completed, so running it raised a second error and left the schema where it was. Three environments sat on that half-applied version for about two hours.",
        tool: { name: "Read", input: { file_path: "db/migrations/0117_split_term_dates.sql" }, result: "ALTER TABLE contract_term ADD COLUMN ends_on date;\nUPDATE contract_term SET ends_on = (valid_range->>'end')::date;" },
      },
      {
        role: "user",
        text: "Then here is the rule from now on, and it is not negotiable: we never merge a migration whose reverse has not been run. Not written, run. You take a copy of the real schema with real-shaped data in it, apply the migration, apply the reverse, and apply it again, in the same run. If the reverse cannot work because the migration loses information, then the migration has to be split into one step that adds and one that removes, and the removing one waits until nothing reads the old shape.",
      },
      {
        role: "assistant",
        text: "Split it that way. The first migration only adds the column and backfills in batches, and I ran apply, reverse and apply again against a copy loaded from a production-shaped dump; all three pass. The statement that drops the old field is a second migration which is not in this branch, since the serializer still reads it. Migrations run through db/run.ts and are numbered sequentially, so the second one will sort after whatever lands in between.",
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npm run migrate", error: "ERROR: null value in column ends_on violates not-null constraint" },
      { kind: "edit", file: "db/migrations/0117_split_term_dates.sql" },
      { kind: "bash-ok", command: "npm run migrate" },
    ],
  },

  {
    id: "an-identifier-that-lost-its-last-digits",
    tier: 2,
    language: "mixed",
    existingSkills: skills(4),
    labels: [
      {
        id: "ids-cross-as-strings",
        kind: "error-fix",
        form: "soft-henceforth",
        position: "middle",
        domain: "identifier-serialization",
        anchor: "bundan sonra kimlikler sınırdan string olarak geçsin",
        lesson:
          "An identifier crosses a service or client boundary as a string, never as a number, because a consumer that parses it as a floating point number silently loses the low digits of a large value; the type at the boundary says string even when the column is an integer.",
        concepts: [
          "identifiers cross the boundary as strings",
          "a numeric identifier loses precision in a client that parses it as a float",
          "the boundary type is a string even when storage is numeric",
        ],
      },
    ],
    distractors: [
      { id: "id-width", fact: "Identifiers in this table are nineteen digits wide.", concepts: ["nineteen digits", "identifier width"] },
      { id: "client-name", fact: "The web client parses the response with its own reader in web/read.ts.", concepts: ["web/read.ts", "which reader"] },
    ],
    turns: around("refunds", 11, 12, [
      {
        role: "user",
        text: "Kullanıcı bir iade kaydını açamıyor, listede görünüyor ama detay isteği bulunamadı diyor. Sebebini bul.",
      },
      {
        role: "assistant",
        text: "The identifier is losing its last two digits between the listing and the detail request. Identifiers in this table are nineteen digits wide, the listing returns them as numbers, and the web client parses the response with its own reader in web/read.ts, which turns every number into a double. A nineteen-digit integer does not fit, so the value it holds is rounded and the detail request asks for an identifier that does not exist. Nothing errors anywhere: the listing is correct, the parse is lossy, and the lookup simply misses.",
        tool: { name: "Bash", input: { command: "node -e \"console.log(9007199254740993)\"" }, result: "9007199254740992" },
      },
      {
        role: "user",
        text: "Tamam, bundan sonra kimlikler sınırdan string olarak geçsin. Kolon integer kalabilir, ama response'a ve request'e string olarak çıkacak, tipinde de string yazacak. Sayı olarak geçen bir kimlik, onu double'a çeviren bir istemcide sessizce bozulur; hata da vermez, sadece yanlış kaydı ister.",
      },
      {
        role: "assistant",
        text: "Changed at the boundary only. The serializer emits the identifier as a string, the request parser accepts a string and converts once, and the declared type says string. The column is untouched. I checked the three other places that return this identifier and changed them too, and the client reader needs no change because a string survives it intact.",
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npx vitest run src/refunds", error: "1 failing: detail lookup returned not found for a listed refund" },
      { kind: "edit", file: "src/refunds/serializer.ts" },
      { kind: "bash-ok", command: "npx vitest run src/refunds" },
    ],
  },

  {
    id: "an-export-that-mangled-half-the-names",
    tier: 2,
    language: "en",
    existingSkills: skills(6),
    labels: [
      {
        id: "encoding-is-named",
        kind: "error-fix",
        form: "soft-henceforth",
        position: "middle",
        domain: "explicit-character-encoding",
        anchor: "every reader and every writer names the encoding it works in",
        lesson:
          "Code that reads or writes text names its character encoding explicitly at every such call, because a default taken from the machine differs between a developer's laptop and a server, and the failure appears only for text outside the plain Latin range.",
        concepts: [
          "name the encoding at every read and write",
          "the platform default differs between machines",
          "the damage shows only on text outside plain Latin characters",
        ],
      },
    ],
    distractors: [
      { id: "export-size", fact: "The payroll export is about fourteen thousand lines a month.", concepts: ["fourteen thousand lines", "export size"] },
      { id: "writer-path", fact: "The export writer is src/payroll/write.ts.", concepts: ["src/payroll/write.ts", "which file"] },
    ],
    turns: around("payroll", 12, 12, [
      {
        role: "user",
        text: "Finance says about a fifth of the names in this month's export came out as question marks, and it was fine last month. Same code, so what changed?",
      },
      {
        role: "assistant",
        text: "The code takes the platform's default encoding rather than naming one. Last month the export ran on a machine whose default was already the wide one, this month it ran on the new agent whose default is a single-byte encoding, and every character the single-byte one cannot represent became a question mark on the way out. The export is about fourteen thousand lines a month and the writer is src/payroll/write.ts, which opens the file with no encoding argument at all, so the same source data produces two different files depending on where it runs.",
        tool: { name: "Read", input: { file_path: "src/payroll/write.ts" }, result: "const out = createWriteStream(target);\nout.write(rows.map(toLine).join(\"\\n\"));" },
      },
      {
        role: "user",
        text: "Right. From here on every reader and every writer names the encoding it works in, in the call itself, and we do not rely on what the machine happens to default to. A default is how a bug becomes something that only reproduces on one person's laptop, and this one only shows up on names that are not plain Latin, which means the people it breaks for are never the ones testing it.",
      },
      {
        role: "assistant",
        text: "Named it at both ends: the writer declares its encoding and so do the two readers that parse the file back in the reconciliation step. I also added a test row whose name needs the wide one, so a change that drops the argument fails the suite rather than one month's export.",
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npm run export:payroll", error: "checksum mismatch against the previous month for 2841 rows" },
      { kind: "edit", file: "src/payroll/write.ts" },
      { kind: "bash-ok", command: "npm run export:payroll" },
    ],
  },

  {
    id: "rows-are-not-deleted-in-one-step",
    tier: 2,
    language: "en",
    existingSkills: skills(8),
    labels: [
      {
        id: "deletion-procedure",
        kind: "procedure",
        form: "hard-never",
        position: "middle",
        domain: "data-deletion-procedure",
        // The rule is stated inside a turn of more than 600 characters, so the recorder
        // treats it as a task brief and it reaches the model through the slice alone. That
        // is the production mix rather than a defect - most of what a developer types is
        // too long to be recorded - and it is declared here so a miss here cannot be
        // confused with a lesson the model was never shown.
        presence: { corrections: false },
        anchor: "nothing is deleted in one step in this system",
        lesson:
          "Deleting stored records is a staged procedure, never a single statement: export the rows that will go, mark them deleted and leave them in place while the readers are observed, and only remove them for good once nothing has read them for the agreed window.",
        concepts: [
          "export the affected rows before anything is removed",
          "mark deleted rather than removing in one step",
          "watch whether anything still reads them",
          "remove for good only after an agreed quiet period",
        ],
      },
    ],
    distractors: [
      { id: "row-volume", fact: "The cleanup covers about ninety thousand consent records.", concepts: ["ninety thousand", "how many rows"] },
      { id: "retention-window", fact: "The agreed quiet period here is thirty days.", concepts: ["thirty days", "quiet period length"] },
    ],
    turns: around("consent", 12, 11, [
      {
        role: "user",
        text: "We need the expired consent records out of the table, about ninety thousand of them. Tell me how you would do it before you write anything.",
      },
      {
        role: "assistant",
        text: "The straightforward version is a single delete against the expiry column, run in batches so the transaction stays small, with an index on the column to keep each batch cheap. That would take a few minutes in total and the table would be clean at the end of it.",
      },
      {
        role: "user",
        text: "No, and this is worth you knowing in general: nothing is deleted in one step in this system. First you export the rows that are going, somewhere durable and outside the database. Then you mark them deleted and leave them exactly where they are, and everything that reads the table filters them out. Then you watch, for the agreed period, whether anything is still asking for them, because the thing that reads a record nobody thought was read is always the one you find this way. Only when that period has gone by quietly do you actually remove them. Skipping the middle part is how a deletion becomes an incident you cannot undo.",
      },
      {
        role: "assistant",
        text: "Written that way. The export runs first and writes a file per batch with the row count in the name, the mark step sets the deleted instant, the read path filters on it, and the removal is a separate script nobody runs yet. The quiet period agreed here is thirty days, so the removal script takes the cutoff as an argument rather than computing it, which means it cannot be run early by accident.",
        tool: { name: "Bash", input: { command: "npm run consent:export -- --expired" }, result: "wrote 9 files, 90412 rows total" },
      },
      {
        role: "user",
        text: "Good. And the read path filter has a test?",
      },
      {
        role: "assistant",
        text: "It does, both directions: a marked record is absent from the listing and absent from the single lookup, and an unmarked one is present in both.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/consent/cleanup.ts" },
      { kind: "bash-ok", command: "npm run consent:export -- --expired" },
      { kind: "edit", file: "src/consent/repository.ts" },
      { kind: "bash-ok", command: "npx vitest run src/consent" },
    ],
  },

  {
    id: "a-setting-arrives-with-four-things-or-not-at-all",
    tier: 2,
    language: "en",
    existingSkills: skills(1),
    labels: [
      {
        id: "config-key-addition",
        kind: "procedure",
        form: "hard-never",
        position: "opening",
        domain: "configuration-key-addition",
        anchor: "A new setting never arrives on its own",
        lesson:
          "Adding a configuration setting means adding four things together: a declared type with a default, a check at startup that refuses to run on a malformed value, a line where the settings are documented, and a test that boots the process without the setting present.",
        concepts: [
          "declare the setting with a type and a default",
          "validate it at startup and refuse to run when it is wrong",
          "document it where the settings are listed",
          "a test boots without the setting set",
        ],
      },
    ],
    distractors: [
      { id: "setting-count", fact: "There are twenty-six settings in the declaration today.", concepts: ["twenty-six settings", "how many"] },
      { id: "default-value", fact: "The new poll interval defaults to forty-five seconds.", concepts: ["forty-five seconds", "default value"] },
    ],
    turns: around("shipments", 0, 23, [
      {
        role: "user",
        text: "Before the actual work, one thing I want followed here. A new setting never arrives on its own: it comes with its declared type and a default, with a check that runs at startup and refuses to start on a value of the wrong shape, with a line where the settings are written down, and with a test that starts the process without it set at all. Four things, together, in the same change. A setting that is read straight out of the environment in the middle of a request is how we end up with a process that runs for six hours and then dies on a value nobody set.",
      },
      {
        role: "assistant",
        text: "Understood. What is the setting for this change?",
      },
      {
        role: "user",
        text: "The carrier poll interval. It is hard-coded to a minute in the tracking worker and the carrier wants it configurable.",
      },
      {
        role: "assistant",
        text: "Added all four. The interval is declared as a duration with a default of forty-five seconds, the startup check rejects anything that is not a positive duration and names the setting in the message, the settings list has a line saying what it controls and what happens at the extremes, and there is a test that boots with an empty environment and asserts the default took effect. That makes twenty-six settings in the declaration. The worker reads it from the resolved settings object rather than the environment.",
        tool: { name: "Edit", input: { file_path: "src/config/declare.ts" }, result: "2 edits applied" },
      },
    ]),
    work: [
      { kind: "edit", file: "src/config/declare.ts" },
      { kind: "edit", file: "src/shipments/poll.ts" },
      { kind: "bash-ok", command: "npx vitest run src/config" },
    ],
  },

  // ── the lesson nobody states ──────────────────────────────────────────────
  //
  // Nine labels whose canonical sentence was never uttered by anybody. The same mistake is
  // corrected twice on its own terms, or the developer quietly reverts the same thing twice,
  // or a procedure is carried out step by step because each step was asked for - and no turn
  // in the session generalises any of it. This is the half of the product's first sentence
  // tier 1 could not reach, and it is what a real session mostly contains.

  {
    id: "two-comments-rewritten-without-a-word-about-comments",
    tier: 2,
    language: "en",
    existingSkills: skills(3),
    labels: [
      {
        id: "comment-carries-the-reason",
        kind: "correction",
        form: "unstated",
        position: "middle",
        domain: "what-a-comment-says",
        anchor: "I rewrote both of the comments you added",
        lesson:
          "A comment states why the code is the way it is - the measurement behind a number, the failure a guard prevents - and never restates what the line already says, because a restatement goes stale silently while a reason stays true or is visibly wrong.",
        concepts: [
          "a comment gives the reason rather than a restatement",
          "name the measurement or the failure behind the code",
          "a comment repeating the code adds nothing",
        ],
      },
    ],
    distractors: [
      { id: "batch-size-fact", fact: "The batch size in the sweep is two hundred.", concepts: ["two hundred", "batch size"] },
      { id: "retry-count-fact", fact: "The sweep gives up after four attempts.", concepts: ["four attempts", "retry count"] },
    ],
    turns: around("intake", 11, 11, [
      {
        role: "user",
        text: "I rewrote both of the comments you added in the sweep. Pull and look at the diff before you carry on with the rest of it.",
      },
      {
        role: "assistant",
        text: "I see them. Mine said that the loop iterates over the pending uploads and that the counter is incremented per batch. Yours say instead that the batch size is two hundred because a larger batch held the lock long enough for the reader to time out, and that the attempt ceiling is four because the carrier's own retry window is fifteen minutes and a fifth attempt would land outside it. Both of yours name something I could not have read off the code.",
      },
      {
        role: "user",
        text: "Right. Carry on with the expiry part, same file.",
      },
      {
        role: "assistant",
        text: "Expiry part done. The comment on the cutoff says that thirty days is the window the intake agreement gives a sender to replace a rejected upload.",
        tool: { name: "Edit", input: { file_path: "src/intake/sweep.ts" }, result: "3 edits applied" },
      },
    ]),
    work: [
      { kind: "edit", file: "src/intake/sweep.ts" },
      { kind: "bash-ok", command: "npx vitest run src/intake" },
    ],
  },

  {
    id: "a-helper-put-back-twice",
    tier: 2,
    language: "mixed",
    existingSkills: skills(5),
    labels: [
      {
        id: "no-abstraction-for-one-caller",
        kind: "correction",
        form: "unstated",
        position: "middle",
        domain: "premature-abstraction",
        anchor: "senin çıkardığın helper'ı geri aldım",
        lesson:
          "Code with a single caller stays where it is used: a helper, a wrapper or a base class is introduced when a second caller actually exists, because an abstraction built for one use hides the code without saving any and has to be undone before the second use can differ from the first.",
        concepts: [
          "do not extract a helper that has one caller",
          "wait until a second caller exists",
          "do not add generalising parameters ahead of a second caller",
        ],
      },
    ],
    distractors: [
      { id: "line-count-fact", fact: "The validator is about sixty lines long.", concepts: ["sixty lines", "how long"] },
      { id: "module-count", fact: "Four modules import the routing validator today.", concepts: ["four modules", "how many importers"] },
    ],
    turns: around("routing", 12, 11, [
      {
        role: "user",
        text: "Dün senin çıkardığın helper'ı geri aldım, gövdesini tek çağıranın içine geri koydum. Devam etmeden diff'e bak.",
      },
      {
        role: "assistant",
        text: "Looked. The validator is about sixty lines and it was called from one place; after your change it sits inside that one place again and the file is shorter overall because the parameter object I had added to make it general is gone too.",
      },
      {
        role: "user",
        text: "Şimdi de rota karşılaştırmasını yaz, aynı dosyada.",
      },
      {
        role: "assistant",
        text: "Written. I put the comparison inline in the one place that needs it rather than giving it its own function, since nothing else compares routes yet. Four modules import the routing validator today, so if a second caller for the comparison shows up it can be lifted out then.",
        tool: { name: "Edit", input: { file_path: "src/routing/validate.ts" }, result: "2 edits applied" },
      },
      {
        role: "user",
        text: "Bunu da geri aldım, ikinci bir çağıranı olmadan ayrı bir fonksiyona koymuşsun yine. Yerine gövdeyi koydum.",
      },
      {
        role: "assistant",
        text: "Understood, and I see it: I had wrapped the comparison in its own exported function with an options argument even though only the one branch above calls it. Your version is the body in place, no export, no options.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/routing/validate.ts" },
      { kind: "bash-ok", command: "npx vitest run src/routing" },
    ],
  },

  {
    id: "seconds-and-minutes-mixed-up-twice",
    tier: 2,
    language: "en",
    existingSkills: skills(7),
    labels: [
      {
        id: "unit-in-the-name",
        kind: "correction",
        form: "unstated",
        position: "middle",
        domain: "units-in-identifiers",
        anchor: "I renamed it to poll_interval_seconds and fixed the arithmetic",
        lesson:
          "A field, parameter or column holding a quantity carries its unit in its name, so that a conversion error is visible at the point of use rather than in behaviour weeks later; a bare name like timeout or interval is renamed to say what it is measured in.",
        concepts: [
          "the name carries the unit of the quantity",
          "a bare timeout or interval name is ambiguous",
          "a wrong conversion becomes visible where the value is used",
        ],
      },
    ],
    distractors: [
      { id: "interval-fact", fact: "The telemetry poll interval is forty-five seconds.", concepts: ["forty-five seconds", "poll interval"] },
      { id: "ttl-fact", fact: "The sample cache keeps entries for ten minutes.", concepts: ["ten minutes", "cache lifetime"] },
    ],
    turns: around("telemetry", 11, 12, [
      {
        role: "user",
        text: "I renamed it to poll_interval_seconds and fixed the arithmetic; you had it multiplying by sixty on a value that was already in seconds, so the poll was sitting there for forty-five minutes.",
      },
      {
        role: "assistant",
        text: "I see the change. The setting is forty-five seconds, I read the name as minutes because the old name said interval and nothing else, and the multiplication turned it into forty-five minutes of waiting between polls, which is why the samples looked like they had stopped arriving.",
      },
      {
        role: "user",
        text: "Now do the cache lifetime for the samples, same module.",
      },
      {
        role: "assistant",
        text: "Added it as a lifetime of ten minutes and divided by a thousand to compare it against the stored instant.",
        tool: { name: "Edit", input: { file_path: "src/telemetry/cache.ts" }, result: "1 edit applied" },
      },
      {
        role: "user",
        text: "Changed that one as well: cache_lifetime_ms, and the division is gone because the stored instant is already in milliseconds. Check the two callers I did not touch.",
      },
      {
        role: "assistant",
        text: "Checked both. One passed a value it had already converted and I have corrected it; the other passes the setting straight through and is fine.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/telemetry/cache.ts" },
      { kind: "bash-fail", command: "npx vitest run src/telemetry", error: "1 failing: sample considered fresh after twelve minutes" },
      { kind: "edit", file: "src/telemetry/poll.ts" },
      { kind: "bash-ok", command: "npx vitest run src/telemetry" },
    ],
  },

  {
    id: "the-test-data-was-refreshed-in-three-steps",
    tier: 2,
    language: "en",
    existingSkills: skills(8),
    labels: [
      {
        id: "fixture-refresh-steps",
        kind: "procedure",
        form: "unstated",
        position: "middle",
        domain: "refreshing-test-data",
        anchor: "work from last night's snapshot, not the live database",
        lesson:
          "Refreshing test data from real data is three steps in order: take a copy of the source rather than reading the live store, remove or replace every personal field in the copy, and only then load it where the tests will read it - so no unmasked data ever exists in a place a test can reach.",
        concepts: [
          "copy the source instead of reading the live store",
          "mask or remove personal fields in the copy",
          "load only the masked copy where tests read it",
          "unmasked data never reaches the test environment",
        ],
      },
    ],
    distractors: [
      { id: "row-total", fact: "The refreshed set is about forty thousand applications.", concepts: ["forty thousand", "how many rows"] },
      { id: "mask-fields", fact: "Six fields are replaced during masking.", concepts: ["six fields", "how many masked"] },
    ],
    turns: around("onboarding", 11, 11, [
      {
        role: "user",
        text: "The test data for onboarding is two years old and the shapes have moved on. Refresh it, but work from last night's snapshot, not the live database, and tell me when you have it somewhere of its own.",
      },
      {
        role: "assistant",
        text: "Restored from last night's snapshot rather than from the live store, about forty thousand applications, into a scratch database that nothing else points at. Nothing has been loaded anywhere the tests read yet.",
        tool: { name: "Bash", input: { command: "npm run snapshot:restore -- --into scratch" }, result: "restored 40218 rows into scratch" },
      },
      {
        role: "user",
        text: "Now strip the personal fields in the scratch copy. Names, addresses, both contact fields, the date of birth and the national identifier.",
      },
      {
        role: "assistant",
        text: "Six fields replaced in the scratch copy: names and addresses with generated values that keep the length distribution, both contact fields with addresses on an invalid domain, the date of birth with the first of the month it fell in, and the national identifier with a checksummed fake.",
      },
      {
        role: "user",
        text: "Good, now load that into the test database and run the suite against it.",
      },
      {
        role: "assistant",
        text: "Loaded from the scratch copy and the suite runs green against it, with two tests updated because they asserted on a field that is now generated. The script drops the scratch database at the end.",
        tool: { name: "Bash", input: { command: "npx vitest run src/onboarding" }, result: "Test Files  6 passed (6)\n     Tests  74 passed (74)" },
      },
    ]),
    work: [
      { kind: "bash-ok", command: "npm run snapshot:restore -- --into scratch" },
      { kind: "edit", file: "scripts/mask.ts" },
      { kind: "bash-ok", command: "npx vitest run src/onboarding" },
    ],
  },

  {
    id: "the-queue-was-emptied-before-the-deploy",
    tier: 2,
    language: "en",
    existingSkills: skills(0),
    labels: [
      {
        id: "drain-before-deploy",
        kind: "procedure",
        form: "unstated",
        position: "middle",
        domain: "deploying-a-message-handler",
        anchor: "turn the schedule off and let it finish what it has",
        lesson:
          "Deploying a change to a message handler starts by stopping new work and letting what is in flight finish: disable the schedule, wait for the queue to reach zero, deploy, then re-enable the schedule - so no message is processed by one version and acknowledged by another.",
        concepts: [
          "stop new work before deploying",
          "wait until the in-flight messages are finished",
          "deploy only against an empty queue",
          "re-enable the schedule afterwards",
        ],
      },
    ],
    distractors: [
      { id: "queue-depth", fact: "The outbound queue had two thousand one hundred notices waiting.", concepts: ["two thousand one hundred", "queue depth"] },
      { id: "drain-time", fact: "Draining took nine minutes.", concepts: ["nine minutes", "how long the drain took"] },
    ],
    turns: around("messaging", 12, 11, [
      {
        role: "user",
        text: "The notice handler change is ready. Before you deploy it, turn the schedule off and let it finish what it has, and tell me the depth when it gets there.",
      },
      {
        role: "assistant",
        text: "Schedule disabled. The outbound queue had two thousand one hundred notices waiting and it took nine minutes to get to zero; nothing is in flight and the handler is idle.",
        tool: { name: "Bash", input: { command: "npm run queue:depth -- outbound" }, result: "outbound: 0 visible, 0 in flight" },
      },
      {
        role: "user",
        text: "Now deploy it.",
      },
      {
        role: "assistant",
        text: "Deployed. The new handler is the only version running now and the queue is still at zero.",
      },
      {
        role: "user",
        text: "Put the schedule back on and watch the first batch.",
      },
      {
        role: "assistant",
        text: "Schedule re-enabled. The first batch of two hundred went through the new handler, all acknowledged, and the retry column stayed at zero across it.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/messaging/handler.ts" },
      { kind: "bash-ok", command: "npm run queue:depth -- outbound" },
      { kind: "bash-ok", command: "npm run deploy -- messaging" },
    ],
  },

  {
    id: "the-same-flake-fixed-twice-in-one-afternoon",
    tier: 2,
    language: "en",
    existingSkills: skills(4),
    labels: [
      {
        id: "temp-dir-per-test",
        kind: "error-fix",
        form: "unstated",
        position: "middle",
        domain: "test-working-directories",
        anchor: "it is the fixed directory again, two tests are writing into it",
        lesson:
          "A test that touches the filesystem creates its own directory and removes it afterwards, instead of writing into a path fixed in the source, because two tests sharing one path pass alone and fail together in an order nobody controls.",
        concepts: [
          "each test makes its own temporary directory",
          "never write into a path fixed in the source",
          "a shared path makes the outcome depend on order",
          "the directory is removed when the test finishes",
        ],
      },
    ],
    distractors: [
      { id: "fixture-path", fact: "The old tests wrote into a directory called tmp-search under the repository.", concepts: ["tmp-search", "which directory"] },
      { id: "worker-count", fact: "The suite runs with four workers here.", concepts: ["four workers", "how many workers"] },
    ],
    turns: around("search", 11, 12, [
      {
        role: "user",
        text: "Two failures in the index tests and they pass when I run either file on its own. Find it.",
      },
      {
        role: "assistant",
        text: "It is a shared directory. Both files write their index into tmp-search under the repository, spelled out in both test files, and the suite runs with four workers here, so the two run at once and each deletes the other's segment files between writing and reading. Running either alone leaves the directory to one file and both assertions hold.",
        tool: { name: "Bash", input: { command: "npx vitest run src/search" }, result: "FAIL src/search/index.test.ts > reads back what it wrote\n  Error: ENOENT: no such file or directory, open 'tmp-search/segment-0'" },
      },
      {
        role: "user",
        text: "Fix those two, then carry on with the compaction change.",
      },
      {
        role: "assistant",
        text: "Both fixed: each of those two now makes a directory under the system temporary path in its setup and removes it in its teardown. Compaction change is next.",
      },
      {
        role: "user",
        text: "The compaction test is red now and it is the fixed directory again, two tests are writing into it. Same thing you just did.",
      },
      {
        role: "assistant",
        text: "Corrected it the same way as the other two, and swept the module: two more files were pointing at that directory and I changed those as well. Green with four workers and with one.",
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npx vitest run src/search", error: "ENOENT: no such file or directory, open 'tmp-search/segment-0'" },
      { kind: "edit", file: "src/search/index.test.ts" },
      { kind: "bash-ok", command: "npx vitest run src/search" },
      { kind: "edit", file: "src/search/compaction.test.ts" },
    ],
  },

  {
    id: "the-generated-client-was-behind-twice",
    tier: 2,
    language: "en",
    existingSkills: skills(9),
    labels: [
      {
        id: "generated-client-regenerated",
        kind: "error-fix",
        form: "unstated",
        position: "middle",
        domain: "generated-code-freshness",
        anchor: "regenerate it rather than adding the field by hand",
        lesson:
          "Generated code is regenerated from its source of truth and never edited by hand, and the regeneration belongs in the same change as the schema it follows, because a hand-edited or stale generated file compiles against a shape the other side no longer has.",
        concepts: [
          "regenerate rather than editing generated code",
          "the generator's input is the source of truth",
          "regenerate in the same change as the schema",
        ],
      },
    ],
    distractors: [
      { id: "generator-cmd", fact: "The client is generated by npm run generate:client.", concepts: ["npm run generate:client", "which command"] },
      { id: "file-size", fact: "The generated client is about four thousand lines.", concepts: ["four thousand lines", "how big"] },
    ],
    turns: around("inventory", 12, 11, [
      {
        role: "user",
        text: "Type error on the branch and it names a field that exists in the schema. Have a look.",
      },
      {
        role: "assistant",
        text: "The generated client is behind. The schema has the field, the generated client is about four thousand lines and was last produced before it was added, and the type error is the client's own type missing the property rather than anything in the code being wrong.",
        tool: { name: "Bash", input: { command: "npm run typecheck" }, result: "src/inventory/reconcile.ts:82:24 - error TS2339: Property 'countedAt' does not exist on type 'StockCount'." },
      },
      {
        role: "user",
        text: "Regenerate it rather than adding the field by hand, and put the result in this change.",
      },
      {
        role: "assistant",
        text: "Ran npm run generate:client and committed its output next to the schema change. The type error is gone.",
      },
      {
        role: "user",
        text: "Now the stock adjustment endpoint, same branch.",
      },
      {
        role: "assistant",
        text: "That one raised the same error again, for the adjustment type this time, because its schema change also landed without the generator being run. I ran the generator once more rather than touching the file, and both types now match.",
        tool: { name: "Bash", input: { command: "npm run generate:client && npm run typecheck" }, result: "generated 4112 lines\nNo errors." },
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npm run typecheck", error: "error TS2339: Property 'countedAt' does not exist on type 'StockCount'." },
      { kind: "edit", file: "src/inventory/reconcile.ts" },
      { kind: "bash-ok", command: "npm run typecheck" },
    ],
  },

  {
    id: "an-amount-changed-to-minor-units-twice",
    tier: 2,
    language: "en",
    existingSkills: skills(6),
    labels: [
      {
        id: "money-in-minor-units",
        kind: "correction",
        form: "unstated",
        position: "middle",
        domain: "money-representation",
        anchor: "I changed the column to an integer of minor units and the field with it",
        lesson:
          "A monetary amount is held and passed as a whole number of the currency's smallest unit together with the currency, never as a floating point number, because a binary fraction cannot represent most decimal amounts exactly and the error accumulates over a sum.",
        concepts: [
          "money is an integer number of minor units",
          "the currency travels with the amount",
          "a floating point number cannot hold most decimal amounts exactly",
          "the error accumulates when amounts are added",
        ],
      },
    ],
    distractors: [
      { id: "cent-diff", fact: "The reconciliation was out by three cents over eleven thousand invoices.", concepts: ["three cents", "eleven thousand invoices"] },
      { id: "currency-list", fact: "Two currencies are in use today.", concepts: ["two currencies", "how many"] },
    ],
    turns: around("billing", 12, 12, [
      {
        role: "user",
        text: "I changed the column to an integer of minor units and the field with it, and the reconciliation difference went away. It was three cents over eleven thousand invoices.",
      },
      {
        role: "assistant",
        text: "I see both changes. The column was a double and the serializer emitted a decimal number, so the amount was rounded on the way in and again on the way out; as an integer of minor units with the currency beside it neither step loses anything, and the sum matches what the client computes.",
      },
      {
        role: "user",
        text: "Now add the credit note amount to the same response.",
      },
      {
        role: "assistant",
        text: "Added it as a decimal with two places, matching what the invoice field looked like before your change.",
        tool: { name: "Edit", input: { file_path: "src/billing/serializer.ts" }, result: "1 edit applied" },
      },
      {
        role: "user",
        text: "Changed that one too, same as the other: integer minor units, currency alongside it. Two currencies are in use today so the pair has to travel together.",
      },
      {
        role: "assistant",
        text: "Understood. I have taken the same shape through the two remaining amount fields in this response, so all four now read the same way.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/billing/serializer.ts" },
      { kind: "bash-fail", command: "npx vitest run src/billing/reconcile.test.ts", error: "1 failing: total differs by 3" },
      { kind: "bash-ok", command: "npx vitest run src/billing/reconcile.test.ts" },
    ],
  },

  {
    id: "a-measurement-was-added-in-four-steps",
    tier: 2,
    language: "en",
    existingSkills: skills(1),
    labels: [
      {
        id: "metric-addition-steps",
        kind: "procedure",
        form: "unstated",
        position: "middle",
        domain: "adding-a-measurement",
        anchor: "give it a name that says what it counts and what it is measured in",
        lesson:
          "Adding a measurement is four steps in order: name it so the name says what is counted and in which unit, emit it where the work actually finishes, show it where people are already looking, and set a threshold on it that tells someone to act - a measurement nobody watches and nobody is alerted by is not finished.",
        concepts: [
          "the name says what is counted and in which unit",
          "emit it at the point the work completes",
          "add it to the view people already watch",
          "give it a threshold that prompts action",
        ],
      },
    ],
    distractors: [
      { id: "metric-name", fact: "The counter is called claims_assessed_total.", concepts: ["claims_assessed_total", "metric name"] },
      { id: "threshold-value", fact: "The alert fires under two hundred an hour.", concepts: ["two hundred an hour", "threshold"] },
    ],
    turns: around("claims", 11, 12, [
      {
        role: "user",
        text: "We are blind on how many claims the assessment step actually finishes. Add a counter for it, and give it a name that says what it counts and what it is measured in.",
      },
      {
        role: "assistant",
        text: "Added it as claims_assessed_total, a plain count of completed assessments, incremented where the assessment writes its result rather than where it is picked up, so a claim that fails halfway is not counted as assessed.",
        tool: { name: "Edit", input: { file_path: "src/claims/assess.ts" }, result: "1 edit applied" },
      },
      {
        role: "user",
        text: "Put it on the assessment dashboard, next to the queue depth.",
      },
      {
        role: "assistant",
        text: "On the assessment dashboard beside the queue depth, as a rate per hour with the raw total on hover, rather than on a page of its own.",
      },
      {
        role: "user",
        text: "And it needs a threshold, otherwise nobody sees it until someone asks. Under two hundred an hour during the working day means something is stuck.",
      },
      {
        role: "assistant",
        text: "Threshold set at two hundred an hour during working hours, wired to the same destination as the other assessment alerts, with the dashboard panel linked from the alert text so whoever gets it lands on the number rather than on a search.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/claims/assess.ts" },
      { kind: "edit", file: "infra/dashboards/claims.json" },
      { kind: "bash-ok", command: "npx vitest run src/claims" },
    ],
  },

  // ── the other two empty cells: implicit, but not silent ────────────────────
  //
  // `implicit` is the middle case between a stated rule and an unstated one: the developer
  // never says the rule, but they push back on the general case rather than on the instance,
  // and the lesson assembles out of two or three of those pushbacks. Tier 1 had six of
  // these and five were error-fixes, so this is where the nesting gets broken.

  {
    id: "a-rollback-put-back-in-the-right-order",
    tier: 2,
    language: "en",
    existingSkills: skills(2),
    labels: [
      {
        id: "rollback-order",
        kind: "procedure",
        form: "implicit",
        position: "middle",
        domain: "rolling-back-an-incident",
        anchor: "not that way round",
        lesson:
          "Rolling back a bad release goes in a fixed order: put the previous version of the code back first, repair the data it wrote second, and only re-enable the scheduled work once the repaired counts have been compared against what they should be - each step verified before the next begins.",
        concepts: [
          "restore the previous version of the code first",
          "repair the data it wrote afterwards",
          "compare the repaired counts before resuming",
          "re-enable scheduled work last",
        ],
      },
    ],
    distractors: [
      { id: "bad-rows", fact: "Four hundred and six slots were written with the wrong duration.", concepts: ["four hundred and six", "how many rows"] },
      { id: "previous-version", fact: "The previous release is the one tagged two days earlier.", concepts: ["two days earlier", "which release"] },
    ],
    turns: around("scheduling", 11, 11, [
      {
        role: "user",
        text: "The slot regeneration wrote four hundred and six slots with the wrong duration. Get us out of it.",
      },
      {
        role: "assistant",
        text: "I will start by fixing the four hundred and six rows with a corrective update, then put the previous release back, then let the schedule carry on.",
      },
      {
        role: "user",
        text: "Not that way round. What is still running while you do that?",
      },
      {
        role: "assistant",
        text: "The current release is. I have rolled back to the release tagged two days earlier and the writing has stopped; the four hundred and six rows are still wrong.",
      },
      {
        role: "user",
        text: "Now repair them. And no, do not turn the schedule back on when you are done with that.",
      },
      {
        role: "assistant",
        text: "Repaired the four hundred and six rows and left the schedule off. I have the corrected count in front of me: nine hundred and twelve slots for that window, which is what the pattern gives for those two days.",
      },
      {
        role: "user",
        text: "That is the number I wanted to see before anything else runs. Turn it back on.",
      },
      {
        role: "assistant",
        text: "Schedule re-enabled. The first pass added the next window's slots and the totals still match.",
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npm run slots:verify", error: "406 slots have a duration outside the allowed set" },
      { kind: "edit", file: "src/scheduling/regenerate.ts" },
      { kind: "bash-ok", command: "npm run slots:verify" },
    ],
  },

  {
    id: "a-fix-that-had-to-come-off-the-released-tag",
    tier: 2,
    language: "en",
    existingSkills: skills(5),
    labels: [
      {
        id: "hotfix-branching",
        kind: "procedure",
        form: "implicit",
        position: "middle",
        domain: "shipping-an-urgent-fix",
        anchor: "branch it off what is actually running",
        lesson:
          "An urgent fix is branched from the commit that is actually running in production, not from the main line, and it is carried back to the main line afterwards as its own commit - so the release carries the fix and nothing else that has landed since.",
        concepts: [
          "branch from the released commit rather than the main line",
          "the fix ships without unrelated work that has landed since",
          "carry the same fix back to the main line",
          "keep it as its own commit",
        ],
      },
    ],
    distractors: [
      { id: "commits-ahead", fact: "The main line is nineteen commits ahead of what is running.", concepts: ["nineteen commits", "how far ahead"] },
      { id: "fix-size", fact: "The fix itself is two lines.", concepts: ["two lines", "how big the fix is"] },
    ],
    turns: around("pricing", 12, 11, [
      {
        role: "user",
        text: "Price rules are rejecting every rule with a percentage discount and it is live. The fix is small, I want it out today.",
      },
      {
        role: "assistant",
        text: "The comparison treats the percentage as a fraction on one side and a whole number on the other, so anything above zero fails the bounds check. The fix is two lines. I will put it on a branch off master and open it from there.",
      },
      {
        role: "user",
        text: "Branch it off what is actually running instead. How far ahead is the main line?",
      },
      {
        role: "assistant",
        text: "Nineteen commits ahead, and three of those are the new tier model, which is not ready. Rebased the two lines onto that commit instead and the branch now holds nothing else.",
        tool: { name: "Bash", input: { command: "git log --oneline -1" }, result: "9f2c1ab tier model: split the rule matcher (not released)" },
      },
      {
        role: "user",
        text: "Right. And do not leave it only there.",
      },
      {
        role: "assistant",
        text: "Applied the same two lines on top of master as well, in a commit of their own, and left a note on both with the reference of the other.",
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npx vitest run src/pricing", error: "1 failing: percentage rule rejected by bounds check" },
      { kind: "edit", file: "src/pricing/bounds.ts" },
      { kind: "bash-ok", command: "npx vitest run src/pricing" },
    ],
  },

  {
    id: "two-error-messages-sent-back-for-rewriting",
    tier: 2,
    language: "mixed",
    existingSkills: skills(7),
    labels: [
      {
        id: "error-message-audience",
        kind: "correction",
        form: "implicit",
        position: "middle",
        domain: "wording-of-an-error",
        anchor: "bunu okuyan kişi ne yapacağını anlamıyor",
        lesson:
          "An error a caller receives says what they must do differently, in their own terms, and never describes the internal step that failed; the internal detail belongs in the log entry the same failure writes, keyed so the two can be joined.",
        concepts: [
          "the message tells the caller what to change",
          "it is written in the caller's terms, not the system's",
          "internal detail goes to the log instead",
          "the log entry and the response can be joined",
        ],
      },
    ],
    distractors: [
      { id: "status-code", fact: "The endpoint answers with a four hundred and twenty-two on a rejected permit.", concepts: ["four hundred and twenty-two", "status code"] },
      { id: "log-key", fact: "The log entry carries the permit reference as its key.", concepts: ["permit reference", "log key"] },
    ],
    turns: around("permits", 11, 12, [
      {
        role: "user",
        text: "Ruhsat reddedildiğinde dönen mesajı yaz, dört yüz yirmi iki ile dönüyoruz.",
      },
      {
        role: "assistant",
        text: "Written: the response says that the eligibility resolver returned no match for the applicant record in the third validation pass.",
        tool: { name: "Edit", input: { file_path: "src/permits/errors.ts" }, result: "1 edit applied" },
      },
      {
        role: "user",
        text: "Bunu okuyan kişi ne yapacağını anlamıyor. Onun bizim üçüncü doğrulama adımından haberi yok.",
      },
      {
        role: "assistant",
        text: "Rewritten: the response now says that the permit cannot be issued because the address on the application is outside the area this permit covers, and that a new application with an address inside the area will be accepted. The resolver detail is gone from the response and is written to the log entry instead, keyed by the permit reference.",
      },
      {
        role: "user",
        text: "İkincisi de aynı: süresi geçmiş ruhsat mesajını da yazdın, orada da bizim iç adımımızı anlatıyorsun.",
      },
      {
        role: "assistant",
        text: "Same treatment. That one now says the permit expired on its end date and what the renewal window is; the expiry pass and its timing go to the log under the same key.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/permits/errors.ts" },
      { kind: "bash-ok", command: "npx vitest run src/permits" },
    ],
  },

  {
    id: "a-test-that-was-asked-what-it-proves",
    tier: 2,
    language: "en",
    existingSkills: skills(10),
    labels: [
      {
        id: "assert-on-the-outcome",
        kind: "correction",
        form: "implicit",
        position: "middle",
        domain: "what-a-test-asserts-on",
        anchor: "that assertion holds when the code is wrong",
        lesson:
          "A test asserts on the outcome the caller can observe - the value returned, the row written, the message sent - and not on which internal functions were called or how often, because an assertion on calls passes for a rewrite that produces the wrong result and fails for a correct one.",
        concepts: [
          "assert on the observable outcome",
          "do not assert on which internal calls happened",
          "a call-count assertion passes on wrong behaviour",
        ],
      },
    ],
    distractors: [
      { id: "call-count", fact: "The aggregation calls the reader twice per response.", concepts: ["twice per response", "how many calls"] },
      { id: "response-total", fact: "The aggregate for the sample window is one hundred and eighty.", concepts: ["one hundred and eighty", "the total"] },
    ],
    turns: around("surveys", 11, 12, [
      {
        role: "user",
        text: "Write the test for the aggregation change.",
      },
      {
        role: "assistant",
        text: "Written: it stubs the reader and asserts the reader was called twice per response and that the summariser was called once with the rows in order.",
        tool: { name: "Edit", input: { file_path: "src/surveys/aggregate.test.ts" }, result: "1 edit applied" },
      },
      {
        role: "user",
        text: "But that assertion holds when the code is wrong. Change the summariser to add the wrong pair of numbers and run it.",
      },
      {
        role: "assistant",
        text: "You are right, it passes. The reader is still called twice and the summariser still receives the rows in order, so the test is green while the aggregate it produces is wrong. Rewritten to assert on the aggregate itself, which is one hundred and eighty for the sample window, and it now fails with the deliberate mistake in place and passes without it.",
      },
      {
        role: "user",
        text: "Do the same to the one you wrote yesterday for the response filter.",
      },
      {
        role: "assistant",
        text: "Same there: it was asserting that the predicate was called once per row. It now asserts which responses come back for a window that includes a partial one, and I checked that it fails if the boundary comparison is flipped.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/surveys/aggregate.test.ts" },
      { kind: "bash-fail", command: "npx vitest run src/surveys", error: "1 failing: aggregate for the sample window was 174, expected 180" },
      { kind: "bash-ok", command: "npx vitest run src/surveys" },
    ],
  },

  // ── three lessons an existing skill already covers ─────────────────────────
  //
  // The prompt tells the model to produce nothing that overlaps an existing skill, and the
  // sieve drops an item whose slug matches one. Tier 1 injected an empty list, so neither of
  // those was ever exercised: its "the sieve dropped nothing" result simply did not cover
  // the duplicate branch. Here the covering skill is in the session's own list, named as the
  // harvest would most plausibly name the lesson itself, and the right outcome is that
  // NOTHING comes back for this label. These labels leave every recall denominator.

  {
    id: "a-request-identifier-that-stopped-at-the-boundary",
    tier: 2,
    language: "en",
    existingSkills: skillsCovering(0, {
      name: "propagate-the-request-id",
      description: "Use when a request crosses a layer, a queue or a service boundary: carry the request identifier with it and put it on every log line, so one request can be followed end to end.",
    }),
    labels: [
      {
        id: "request-id-propagation",
        kind: "correction",
        form: "hard-never",
        position: "middle",
        domain: "following-one-request",
        coveredBy: "propagate-the-request-id",
        anchor: "the identifier travels with the work, all the way down",
        lesson:
          "Every unit of work carries the identifier of the request that caused it across each layer, queue and service boundary, and every log line it produces names that identifier, so one request can be followed from where it entered to where it finished.",
        concepts: [
          "the request identifier travels with the work",
          "across queue and service boundaries too",
          "every log line carries it",
          "one request can be followed end to end",
        ],
      },
    ],
    distractors: [
      { id: "header-name-fact", fact: "The identifier arrives in a header called x-trace-ref.", concepts: ["x-trace-ref", "header name"] },
      { id: "log-lines", fact: "A single tenancy request writes about nine log lines.", concepts: ["nine log lines", "how many"] },
    ],
    turns: around("tenancy", 11, 11, [
      {
        role: "user",
        text: "Support cannot follow a provisioning request past the queue. Have a look at what we log.",
      },
      {
        role: "assistant",
        text: "The identifier arrives in a header called x-trace-ref and the handler logs it, but the message it publishes does not carry it, so the worker that does the actual provisioning logs its own generated value instead. A single tenancy request writes about nine log lines and the first three can be joined to each other and to nothing after them.",
        tool: { name: "Grep", input: { pattern: "x-trace-ref", path: "src/tenancy" }, result: "src/tenancy/handler.ts:41:  const ref = headers[\"x-trace-ref\"];" },
      },
      {
        role: "user",
        text: "Then fix it so the identifier travels with the work, all the way down. It goes on the message, the worker reads it instead of making one up, and every line either of them writes names it. A request we cannot follow end to end is a request we cannot answer a question about.",
      },
      {
        role: "assistant",
        text: "Done. The identifier is a field on the published message, the worker takes it from there, and both log through the same helper so no line can be written without it. I followed one request from the handler through the queue to the provisioning result and all nine lines join on the same value.",
      },
    ]),
    work: [
      { kind: "edit", file: "src/tenancy/handler.ts" },
      { kind: "edit", file: "src/tenancy/worker.ts" },
      { kind: "bash-ok", command: "npx vitest run src/tenancy" },
    ],
  },

  {
    id: "a-backup-nobody-had-restored",
    tier: 2,
    language: "en",
    existingSkills: skillsCovering(4, {
      name: "verify-a-backup-restore",
      description: "Use when a backup needs to be trusted: restore it into a scratch place, compare the row counts and the newest record against the source, and write down when it was last proven.",
    }),
    labels: [
      {
        id: "restore-is-the-proof",
        kind: "procedure",
        form: "soft-henceforth",
        position: "middle",
        domain: "proving-a-backup",
        coveredBy: "verify-a-backup-restore",
        anchor: "a backup nobody has restored is not a backup",
        lesson:
          "A backup counts as working only once it has been restored somewhere disposable and compared against the source - row counts and the newest record - on a stated schedule, with the date of the last successful restore written down where anyone can see it.",
        concepts: [
          "restore the backup into a disposable place",
          "compare counts and the newest record against the source",
          "repeat it on a stated schedule",
          "record when it was last proven",
        ],
      },
    ],
    distractors: [
      { id: "backup-age", fact: "The reporting backup runs at half past two every morning.", concepts: ["half past two", "when it runs"] },
      { id: "restore-duration", fact: "The restore took twenty-six minutes.", concepts: ["twenty-six minutes", "how long"] },
    ],
    turns: around("reporting", 12, 11, [
      {
        role: "user",
        text: "Someone asked in the review whether we could restore the reporting data and nobody knew. Find out.",
      },
      {
        role: "assistant",
        text: "The backup runs at half past two every morning and the files are there for every day of the last month, so the job is working. Whether they restore is a different question and there is no record of anyone having tried.",
      },
      {
        role: "user",
        text: "Then try it, and from here on a backup nobody has restored is not a backup. Restore it into somewhere disposable, compare the row counts and the newest record against the source, and write down the date it was last proven so the next person does not have to ask. Once a month is enough for this one.",
      },
      {
        role: "assistant",
        text: "Restored last night's file into a scratch database in twenty-six minutes. Eighteen tables match; the two that are written continuously are behind by the minutes between the snapshot and the copy, and the newest report in the copy is the one from just before it. Yesterday's date and the comparison are in the operations notes, with a reminder on the same page.",
        tool: { name: "Bash", input: { command: "npm run backup:restore -- --into scratch --date last-night" }, result: "restore complete in 26m04s\nrow counts: 18 tables matched, 2 behind by <1m" },
      },
    ]),
    work: [
      { kind: "bash-ok", command: "npm run backup:restore -- --into scratch --date last-night" },
      { kind: "edit", file: "docs/operations.md" },
    ],
  },

  {
    id: "connections-that-were-never-given-back",
    tier: 2,
    language: "en",
    existingSkills: skillsCovering(8, {
      name: "return-a-borrowed-connection",
      description: "Use when code takes a connection, a lock or a file handle from a pool: give it back in the unwind path so an error cannot leak it, and bound the pool so a leak shows up as a wait rather than as memory.",
    }),
    labels: [
      {
        id: "return-what-you-borrow",
        kind: "error-fix",
        form: "hard-never",
        position: "middle",
        domain: "borrowed-resources",
        coveredBy: "return-a-borrowed-connection",
        anchor: "whatever you take from the pool goes back in the unwind path",
        lesson:
          "Anything taken from a pool - a connection, a lock, a handle - is released in the path that runs whether the work succeeded or failed, and the pool is bounded so that a leak appears immediately as callers waiting rather than later as an exhausted machine.",
        concepts: [
          "release the borrowed resource in the unwind path",
          "it must be released on the failure path too",
          "bound the pool",
          "a leak then shows up as waiting rather than exhaustion",
        ],
      },
    ],
    distractors: [
      { id: "pool-size", fact: "The pool is set to sixteen connections.", concepts: ["sixteen connections", "pool size"] },
      { id: "wait-time", fact: "Callers were waiting about eight seconds before it fell over.", concepts: ["eight seconds", "how long callers waited"] },
    ],
    turns: around("metering", 11, 12, [
      {
        role: "user",
        text: "The usage rollup ran out of connections again overnight. Work out where they are going.",
      },
      {
        role: "assistant",
        text: "The rollup takes a connection per batch and returns it after the summary write. When the summary write throws, which it does on a duplicate reading, the return never runs and the connection stays out. The pool is sixteen and there were fourteen leaked by the time it stopped; callers were waiting about eight seconds before it fell over.",
        tool: { name: "Bash", input: { command: "npm run metering:rollup" }, result: "Error: timeout acquiring connection after 8000ms\n    at Pool.acquire (src/metering/pool.ts:52:11)" },
      },
      {
        role: "user",
        text: "Then whatever you take from the pool goes back in the unwind path, not at the end of the happy path. That holds for locks and file handles too, and the pool stays bounded so the next leak shows up as someone waiting rather than as a machine falling over at four in the morning.",
      },
      {
        role: "assistant",
        text: "Moved the release into the unwind path so it runs whether the batch succeeded or threw, and did the same for the advisory lock the rollup takes and for the export handle, both of which had the same shape. The pool is still sixteen, deliberately, and I added a test that makes the summary write throw and asserts the pool is back to full afterwards.",
      },
    ]),
    work: [
      { kind: "bash-fail", command: "npm run metering:rollup", error: "Error: timeout acquiring connection after 8000ms" },
      { kind: "edit", file: "src/metering/rollup.ts" },
      { kind: "bash-ok", command: "npm run metering:rollup" },
    ],
  },

  // ── a dense session with no lesson in it ──────────────────────────────────
  //
  // Tier 1's lesson-free session is 835 characters of small errands. This one is the same
  // idea at tier-2 density: a full day of real work, a full existing-skill list, three
  // one-system facts and nothing anybody taught. It is the only floor precision has under
  // it here, and the one place where every item kept is noise by construction.

  {
    id: "a-long-day-of-ordinary-work",
    tier: 2,
    language: "en",
    existingSkills: skills(3, 5),
    labels: [],
    distractors: [
      { id: "index-name", fact: "The index the filter uses is on the status column of the catalog table.", concepts: ["status column", "which index"] },
      { id: "version-count", fact: "Nineteen commits are on the branch.", concepts: ["nineteen commits", "how many"] },
      { id: "worker-total", fact: "The reindex runs with four workers.", concepts: ["four workers", "how many workers"] },
    ],
    turns: noiseTurns({ theme: "catalog", exchanges: 24 }),
    work: [
      { kind: "edit", file: "src/catalog/filter.ts" },
      { kind: "bash-ok", command: "npx vitest run src/catalog" },
      { kind: "edit", file: "src/catalog/summary.ts" },
    ],
  },
];
