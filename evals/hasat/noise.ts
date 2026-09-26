// The filler that makes a tier-2 session as dense as a real one.
//
// Tier 1's sessions are legible by construction and measurably so: the slice that reached
// the model was a median of 824 characters against the product's 40,000-character cap, the
// median session had three user turns, and the turn carrying the lesson was a median of 70%
// of everything the developer said. A number taken there is the ceiling of production
// recall, because in production the slice FILLS and the lesson is one short turn among
// hundreds.
//
// So tier 2 needs bulk, and the bulk has three jobs at once:
//
//   - fill the slice. The slicer gives the developer 60% of 40,000 characters, caps each of
//     their turns at 1,000 and each assistant turn at 1,500. Filling it therefore takes
//     turns of that size, not more of them: twenty 200-character errands fill 4,000
//     characters and measure nothing.
//   - mimic production's EVIDENCE mix. The prompt recorder ignores a prompt longer than 600
//     characters as a task brief rather than a rule, so a session of long briefs reaches the
//     model through the slice with only a handful of recorded prompts - which is what a real
//     session looks like, and the opposite of tier 1, where the median session had three
//     prompts and one of them was the rule.
//   - state no RULE of its own. This is weaker than "teach nothing", and the difference was
//     measured rather than assumed: even after the rewrite described below, the harvest
//     generalises the chores themselves into lessons ("run a housekeeping pass before the real
//     work", "accept a new input shape without breaking the old one") in most sessions. A chore
//     described at length is still a thing a model can draw a rule from. What the filler does
//     not do is state a rule in the developer's voice, which is what would make it
//     indistinguishable from a planted label - and that is what `corpus.test.ts` asserts.
//
//     This is the part that had to be MEASURED rather than intended, and the first draft of
//     it failed. That draft filled the sessions with substantial engineering exchanges - a
//     duplicate-delivery bug traced through log timestamps, a flaky test traced to a
//     module-scope counter in a shared fixture - and a pilot run over 9 sessions showed the
//     harvest doing exactly the right thing with them. Of the 7 sessions that returned
//     anything, all 7 proposed filler-derived lessons (`ack-after-durable-write`,
//     `suspect-shared-fixture-state-before-test-ordering`,
//     `confirm-root-cause-before-fixing`), in 4 of them those took two of the three kept
//     slots, and in 2 of them the PLANTED lesson did not come back at all. Whether the
//     filler lessons displaced it cannot be read off that run - nothing was dropped by the
//     sieve, so the model simply never emitted it - but the filler was plainly not noise: it
//     was three more lessons per session, and a label set that names one lesson per session
//     cannot measure precision against a corpus like that.
//
//     So the filler is now bulk without a mechanism: chores stated at length, pasted data,
//     inventories of what changed, counts. Nobody diagnoses anything and nothing explains why
//     anything behaves as it does, because an explanation of a mechanism IS a lesson however
//     the sentence around it is phrased. That moved the filler's own yield from three lessons a
//     session to one or two, and it did not remove it: the measured run kept 86 filler-derived
//     items over three runs, every one of them read by hand and reported. A corpus of dense
//     sessions cannot label everything a dense session contains, which is why this tier's
//     precision is reported as a property of the corpus and not of the product.
//
// What this machinery cannot do is be varied the way a real session is. It is templates
// over themes: nine ways of asking for work and seven of reporting it, filled from a
// theme's own nouns. Two tier-2 sessions do not read alike, but a reader who has seen ten
// of them has seen the shapes. Whether a model finds it easier to ignore templated filler
// than the real thing is not measurable here, and it is the reason tier 3 exists.

import type { Turn } from "./corpus.js";

export interface Theme {
  /** the corner of an invented system this session is working in */
  key: string;
  module: string;
  unit: string;
  units: string;
  dir: string;
  table: string;
  job: string;
  endpoint: string;
}

export const THEMES: Theme[] = [
  { key: "ledger", module: "payout ledger", unit: "entry", units: "entries", dir: "src/ledger", table: "ledger_entry", job: "nightly reconciliation", endpoint: "/ledger/entries" },
  { key: "catalog", module: "product catalog", unit: "listing", units: "listings", dir: "src/catalog", table: "listing", job: "catalog reindex", endpoint: "/catalog/listings" },
  { key: "intake", module: "document intake", unit: "upload", units: "uploads", dir: "src/intake", table: "intake_document", job: "intake sweep", endpoint: "/intake/documents" },
  { key: "billing", module: "billing run", unit: "invoice", units: "invoices", dir: "src/billing", table: "invoice", job: "monthly billing run", endpoint: "/billing/invoices" },
  { key: "routing", module: "delivery routing", unit: "route", units: "routes", dir: "src/routing", table: "delivery_route", job: "route rebuild", endpoint: "/routing/routes" },
  { key: "identity", module: "identity directory", unit: "account", units: "accounts", dir: "src/identity", table: "directory_account", job: "directory sync", endpoint: "/identity/accounts" },
  { key: "metering", module: "usage metering", unit: "reading", units: "readings", dir: "src/metering", table: "usage_reading", job: "usage rollup", endpoint: "/metering/readings" },
  { key: "messaging", module: "outbound messaging", unit: "notice", units: "notices", dir: "src/messaging", table: "outbound_notice", job: "retry sweep", endpoint: "/messaging/notices" },
  { key: "search", module: "search index", unit: "document", units: "documents", dir: "src/search", table: "indexed_document", job: "index compaction", endpoint: "/search/documents" },
  { key: "inventory", module: "inventory counts", unit: "count", units: "counts", dir: "src/inventory", table: "stock_count", job: "stock recount", endpoint: "/inventory/counts" },
  { key: "contracts", module: "contract terms", unit: "term", units: "terms", dir: "src/contracts", table: "contract_term", job: "term expiry pass", endpoint: "/contracts/terms" },
  { key: "telemetry", module: "device telemetry", unit: "sample", units: "samples", dir: "src/telemetry", table: "device_sample", job: "sample downsample", endpoint: "/telemetry/samples" },
  { key: "onboarding", module: "customer onboarding", unit: "application", units: "applications", dir: "src/onboarding", table: "application", job: "application expiry", endpoint: "/onboarding/applications" },
  { key: "refunds", module: "refund handling", unit: "refund", units: "refunds", dir: "src/refunds", table: "refund_request", job: "refund settlement", endpoint: "/refunds/requests" },
  { key: "scheduling", module: "appointment scheduling", unit: "slot", units: "slots", dir: "src/scheduling", table: "appointment_slot", job: "slot regeneration", endpoint: "/scheduling/slots" },
  { key: "pricing", module: "price rules", unit: "rule", units: "rules", dir: "src/pricing", table: "price_rule", job: "price recalculation", endpoint: "/pricing/rules" },
  { key: "shipments", module: "shipment tracking", unit: "shipment", units: "shipments", dir: "src/shipments", table: "shipment", job: "carrier poll", endpoint: "/shipments" },
  { key: "surveys", module: "survey responses", unit: "response", units: "responses", dir: "src/surveys", table: "survey_response", job: "response aggregation", endpoint: "/surveys/responses" },
  { key: "permits", module: "permit applications", unit: "permit", units: "permits", dir: "src/permits", table: "permit", job: "permit renewal pass", endpoint: "/permits" },
  { key: "payroll", module: "payroll export", unit: "line", units: "lines", dir: "src/payroll", table: "payroll_line", job: "payroll export", endpoint: "/payroll/lines" },
  { key: "claims", module: "claim assessment", unit: "claim", units: "claims", dir: "src/claims", table: "claim", job: "claim ageing pass", endpoint: "/claims" },
  { key: "tenancy", module: "tenant provisioning", unit: "tenant", units: "tenants", dir: "src/tenancy", table: "tenant", job: "provisioning sweep", endpoint: "/tenancy/tenants" },
  { key: "reporting", module: "scheduled reporting", unit: "report", units: "reports", dir: "src/reporting", table: "scheduled_report", job: "report delivery", endpoint: "/reporting/reports" },
  { key: "consent", module: "consent records", unit: "record", units: "records", dir: "src/consent", table: "consent_record", job: "consent expiry", endpoint: "/consent/records" },
];

export function themeFor(key: string): Theme {
  const theme = THEMES.find((t) => t.key === key);
  if (!theme) throw new Error(`no such theme: ${key}`);
  return theme;
}

/** A number that varies with the turn but is stable across runs, so a fixture is the same
 * bytes every time it is built. Nothing here is random: a corpus that differs between two
 * runs would put the difference into the measurement. */
function vary(i: number, from: number, to: number): number {
  return from + ((i * 37 + 11) % (to - from + 1));
}

// ── what the developer asks for ─────────────────────────────────────────────
//
// Nine shapes, long by construction rather than padded: a brief, a pasted failure, a review
// note, a list of review comments. Each is above the recorder's 600-character line except
// where noted, because that is the production mix - the recorded-prompt block is mostly
// empty in a real session and full in tier 1.


/** File paths of the shape a directory listing has, so a chore can name the files it touched
 * at the length a real one does. Bulk, not plot: nothing here explains anything. */
function files(t: Theme, i: number, count: number): string {
  const names = [
    "index", "handler", "repository", "serializer", "filter", "summary", "validate", "run",
    "constants", "support", "mapper", "query", "types", "errors", "paginate", "audit",
  ];
  return Array.from(
    { length: count },
    (_, k) => `    ${t.dir}/${names[(i + k) % names.length]}.ts`,
  ).join("\n");
}

/** Rows of the shape an exported data file has. */
function rows(t: Theme, i: number, count: number): string {
  const states = ["open", "closed", "pending", "settled", "void"];
  return Array.from(
    { length: count },
    (_, k) =>
      `    ${1000 + vary(i + k, 100, 999)},2026-0${vary(i + k, 1, 9)}-1${vary(k, 0, 9)},,${states[(i + k) % states.length]},${vary(i + k, 10, 99)}.${vary(k, 10, 99)},EUR,`,
  ).join("\n");
}

type Ask = (t: Theme, i: number) => string;

const ASKS: Ask[] = [
  (t, i) =>
    `Housekeeping on ${t.dir} before the real work. These are all mechanical:\n\n` +
    `    - sort the exported names in index.ts so the diff stops shuffling\n` +
    `    - the ${vary(i, 2, 6)} helpers at the bottom of support.ts are unused, drop them\n` +
    `    - repository.ts imports the ${t.unit} type twice, once as a type and once as a value\n` +
    `    - two of the tests are called "works" and "works 2", give them the names of what they check\n` +
    `    - there is a commented-out block from the old ${t.job} at the end of run.ts, take it out\n` +
    `    - the licence header is missing from the ${vary(i, 2, 5)} newest files in this directory\n\n` +
    `Do them in that order and tell me the file count at the end.`,
  (t, i) =>
    `Here is the first part of the file finance sent, ${vary(i, 30, 90)} rows of it. Make the parser accept this shape and leave the old one working.\n\n` +
    `    ${t.unit}_ref,opened_on,closed_on,state,amount,currency,note\n` +
    rows(t, i, 14) +
    `\n\nThe last column is empty in every row they have ever sent us and they say it will stay that way. Keep it in the shape, accept it empty, and do not make it required.`,
  (t, i) =>
    `Rename ${t.dir}/support.ts to ${t.dir}/${t.unit}-support.ts and update the imports. These are the files that import it:\n\n` +
    files(t, i, 11) +
    `\n\nSame rename in the test files beside them, and tell me the count when it is done.`,
  (t, i) =>
    `Copy the ${t.module} listing page's filter panel into the archive page. Same fields, same order, same labels, and the same empty state. The archive page has its own query so only the panel moves; do not touch what either page fetches. Once it is in place, put the ${vary(i, 2, 5)} strings it uses into the same message file as the rest of the page rather than leaving them inline, and keep the keys in the naming shape the other keys there use.`,
  (t, i) =>
    `Three separate small things, none of them related. First, there is a stray debug statement in ${t.dir}/handler.ts, take it out. Second, the ${vary(i, 2, 6)} strings in the archive banner are still inline; move them into the message file with the others. Third, these files have the old copyright year in the header and it is the only thing wrong with them:\n\n` +
    files(t, i + 3, 9) +
    `\n\nDo all three, keep them in one commit since they are all cosmetic, and give me the line count at the end.`,
  (t, i) =>
    `Pasting the last ${vary(i, 20, 60)} lines of the ${t.job} log because I want the timings written into the ticket, not because anything is wrong:\n\n` +
    Array.from({ length: 16 }, (_, k) => `    1${vary(i, 0, 9)}:${vary(i + k, 10, 58)}:0${vary(k, 0, 9)} ${t.job} batch ${k + 1}/16 ${vary(i + k, 100, 900)} ${t.units} in ${vary(i + k, 2, 40)}.${vary(k, 10, 99)}s read ${vary(i + k, 1000, 9000)} wrote ${vary(k + i, 100, 900)} skipped ${vary(k, 0, 40)}`).join("\n") +
    `\n\nPut the per-batch numbers and the total in the ticket as a table, and round the seconds to one place. No code changes in this one.`,
  (t, i) =>
    `Sort the ${t.table} columns in the schema file alphabetically after the key columns, then regenerate. While you are there, these files still spell the table name in the old way in a comment and it should match:\n\n` +
    files(t, i + 7, 8) +
    `\n\nComments only in those; the code in them is already right. The schema file is the one that matters, the rest is tidying.`,
  (t, i) =>
    `Move the ${vary(i, 3, 9)} ${t.module} constants out of handler.ts into a constants file next to it, exactly as they are, and update the references. Then swap the two functions at the top of handler.ts so the file reads in call order, and put the ${vary(i, 2, 6)} type aliases below them in the same order as the functions that return them. Tell me the file count and the line count when it is done.`,
  (t, i) =>
    `Fill in the missing type annotations in ${t.dir}. The build prints ${vary(i, 3, 14)} warnings about exported functions with inferred return types and they are all in this directory. Tell me how many warnings are left at the end and which files you touched.`,
];

// ── what the assistant reports ──────────────────────────────────────────────
//
// Long, because the assistant's share of the slice is 40% of it and a slice that is all
// developer prose is not the shape the product reads either. Every one of these reports
// work: none of them summarises a rule, which is the assertion holding the corpus up.

type Report = (t: Theme, i: number) => string;

const REPORTS: Report[] = [
  (t, i) =>
    `All six done, in that order. The exported names in index.ts are sorted; the ${vary(i, 2, 6)} unused helpers are gone along with their imports; the duplicate ${t.unit} import in repository.ts is now one line; the two tests are called after what they assert; the commented-out block at the end of run.ts is out; and the licence header is on the ${vary(i, 2, 5)} files that were missing it. Nothing else in ${t.dir} was touched. ${vary(i, 8, 26)} files changed, ${vary(i, 40, 300)} lines removed and ${vary(i, 10, 60)} added, and the suite is the same ${vary(i, 30, 90)} tests it was, all passing. One of those helpers is referenced from a test rather than from the module, so that one is still there and the other ${vary(i, 1, 5)} are gone. Files in the diff:\n\n` +
    files(t, i, 12) +
    `\n\nTest names before and after: "works" is now "rejects a ${t.unit} with no owner" and "works 2" is now "keeps the ${vary(i, 2, 6)} newest ${t.units}".`,
  (t, i) =>
    `The parser takes both shapes now. The new one is recognised by its header row, the old one by the absence of the last two columns, and the choice is made once when the file is opened. The empty column is in the shape as an optional string and the ${vary(i, 30, 90)} rows you pasted all parse; I put them in a fixture file rather than inline, since the row count made the test unreadable otherwise. The old fixtures still parse unchanged. Field for field, the new columns land on: reference, opened instant, closed instant, state, amount, currency, and the note that stays empty. The fixture holds the rows as they arrived:\n\n` +
    rows(t, i, 10) +
    `\n\nCounts from the parse: ${vary(i, 30, 90)} rows in, ${vary(i, 30, 90)} out, ${vary(i, 0, 3)} rejected, and the same numbers on the old fixture as before.`,
  (t, i) =>
    `Renamed, and the imports updated in all eleven, plus the four test files beside them. Files changed:\n\n` +
    files(t, i, 11) +
    `\n\nTwo things I left alone rather than fixing: repository.ts imports it twice (once as a type, once as a value) and query.ts imports it through index.ts rather than directly. Both still compile after the rename. ${vary(i, 30, 90)} tests, all passing, same count as before.`,
  (t, i) =>
    `Panel moved. The archive page has the same fields in the same order with the same labels and the same empty state, and its own query is untouched. The ${vary(i, 2, 5)} strings are in the page's message file under keys in the same shape as the neighbouring ones, and the inline copies are gone from both pages. I put the two pages side by side at the widths the other pages are checked at and they match apart from the heading. Files changed:\n\n` +
    files(t, i + 5, 9) +
    `\n\nFields in the panel, in render order: state, opened between, closed between, ${t.unit} reference, amount from, amount to, currency, and the free-text search. The empty state is one shared string now rather than two copies.`,
  (t, i) =>
    `All three done in one commit. The debug statement is gone and nothing else in ${t.dir}/handler.ts writes to the log. The ${vary(i, 2, 6)} banner strings are in the message file under keys shaped like the neighbouring ones, and the inline copies are gone. The year in the header is updated in these:\n\n` +
    files(t, i + 3, 9) +
    `\n\n${vary(i, 10, 24)} files changed, ${vary(i, 20, 90)} lines added, ${vary(i, 20, 90)} removed, and the suite is the same ${vary(i, 30, 90)} tests it was.`,
  (t, i) =>
    `Table is in the ticket: nine batches, ${vary(i, 100, 900)} to ${vary(i, 900, 1500)} ${t.units} each, per-batch times from ${vary(i, 2, 9)}.${vary(i, 10, 99)}s to ${vary(i, 20, 40)}.${vary(i, 10, 99)}s, total ${vary(i, 60, 400)}.${vary(i, 10, 99)}s, seconds rounded to one place as you asked. I put the batch sizes beside the times, since you may want them in the same table. No code changed.`,
  (t, i) =>
    `Columns sorted after the key columns in the schema file for ${t.table}, ${vary(i, 8, 30)} of them, and the generated file regenerated from it so the two agree. No migration is involved: the order in the schema file is not the order in the database. The comment spelling is updated in these:\n\n` +
    files(t, i + 7, 8) +
    `\n\nThe code in them is untouched. One of the eight also had the name spelled the old way in a test description rather than a comment; I changed that too, since it reads as the same tidying. ${vary(i, 3, 12)} files changed in total and the generated file is the only large one in the diff.`,
  (t, i) =>
    `The ${vary(i, 3, 9)} constants are in constants.ts beside the handler, unchanged in value and name, and the ${vary(i, 4, 18)} references point at them. The two functions at the top of handler.ts are swapped so the file reads in call order, and the ${vary(i, 2, 6)} type aliases follow them in the same order. The suite is the same count, green. Files touched:\n\n` +
    files(t, i + 2, 7) +
    `\n\nplus handler.ts itself, ${vary(i, 20, 80)} lines moved in it.`,
  (t, i) =>
    `Annotated ${vary(i, 3, 14)} of them and one warning is left in ${t.dir}, on the ${t.unit} mapper, which returns a union. Annotated in:\n\n` +
    files(t, i + 9, 10) +
    `\n\nEach of those is one line of diff. Build output went from ${vary(i, 3, 14)} warnings to one.`,
];

export interface NoiseSpec {
  theme: string;
  /** how many ask-and-report exchanges of filler this session carries */
  exchanges: number;
  /** where in the rotation to start, so two sessions on the same theme do not read alike */
  offset?: number;
  /** one in this many exchanges hangs a tool call off the assistant's turn */
  toolEvery?: number;
}

/**
 * The filler exchanges of one tier-2 session, alternating developer and assistant.
 *
 * `offset` rotates both template banks, so the same theme at two offsets is a different
 * session. The tool calls exist because a transcript without them is not the shape the
 * product reads - the reader has to walk past a tool_use block and a tool_result line to
 * find the conversation - and their output is deliberately long: it costs nothing in the
 * slice (the reader keeps only text blocks) and it is what a real transcript is mostly
 * made of.
 */
export function noiseTurns(spec: NoiseSpec): Turn[] {
  const theme = themeFor(spec.theme);
  const offset = spec.offset ?? 0;
  const toolEvery = spec.toolEvery ?? 3;
  const turns: Turn[] = [];
  for (let i = 0; i < spec.exchanges; i++) {
    const n = offset + i;
    turns.push({ role: "user", text: ASKS[n % ASKS.length]!(theme, n) });
    const report: Turn = { role: "assistant", text: REPORTS[n % REPORTS.length]!(theme, n) };
    if (i % toolEvery === 0) report.tool = toolCall(theme, n);
    turns.push(report);
  }
  return turns;
}

/** A tool call and a result of the size a real one has. Skipped by the transcript reader,
 * so it changes no slice measurement; it is here so the file the product reads is shaped
 * like the files it reads in production. */
function toolCall(t: Theme, i: number): NonNullable<Turn["tool"]> {
  const kind = i % 3;
  if (kind === 0) {
    return {
      name: "Bash",
      input: { command: `npx vitest run ${t.dir}` },
      result: [
        `> vitest run ${t.dir}`,
        "",
        ` ✓ ${t.dir}/index.test.ts (${vary(i, 8, 30)} tests) ${vary(i, 200, 900)}ms`,
        ` ✓ ${t.dir}/filter.test.ts (${vary(i, 4, 19)} tests) ${vary(i, 90, 400)}ms`,
        ` ✓ ${t.dir}/summary.test.ts (${vary(i, 3, 14)} tests) ${vary(i, 60, 300)}ms`,
        "",
        ` Test Files  3 passed (3)`,
        `      Tests  ${vary(i, 20, 60)} passed (${vary(i, 20, 60)})`,
        `   Duration  ${vary(i, 2, 9)}.${vary(i, 10, 99)}s`,
      ].join("\n"),
    };
  }
  if (kind === 1) {
    return {
      name: "Read",
      input: { file_path: `${t.dir}/filter.ts` },
      result: [
        `import { statuses } from "./statuses.js";`,
        "",
        `const active = new Set(statuses.filter((s) => s.active).map((s) => s.code));`,
        "",
        `export function visible(rows: Row[]): Row[] {`,
        `  return rows.filter((row) => active.has(row.status));`,
        `}`,
      ].join("\n"),
    };
  }
  return {
    name: "Grep",
    input: { pattern: t.table, path: t.dir },
    result: Array.from({ length: 6 }, (_, k) => `${t.dir}/repository.ts:${vary(i + k, 20, 200)}:  from ${t.table}`).join("\n"),
  };
}
