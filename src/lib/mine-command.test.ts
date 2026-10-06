import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixture, seedStandardHistory } from "./mine-fixture.js";
import type { Fixture } from "./mine-fixture.js";
import { runMineCommand } from "./mine-run.js";
import { draftRefusal, formatWorkflowList, pickWorkflow, workflowsFromShapes } from "./mine-command.js";
import type { Workflow } from "./mine-command.js";
import { mineShapes } from "./mine.js";
import type { MineOptions } from "./mine.js";
import { decideCandidate, formatCandidateList, hygieneLines, readCandidateMeta, rejectionMessage, writeCandidateMeta } from "./queue.js";
import type { CandidateMeta } from "./queue.js";
import { candidatesDir } from "./skill-index.js";

/**
 * The fixture is a few dozen commits where a real history has thousands, so the thresholds
 * are lowered to the ones the engine's own suite reads it at. The product ships the
 * measured defaults; this says out loud that a fixture is not a history.
 */
const FIXTURE_THRESHOLDS: MineOptions = { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3 };

/**
 * Words that belong to the engine and must never reach a user. A reader at this screen is
 * asking "do I recognise this work?"; the vocabulary of how a cluster was found answers a
 * question they did not ask and invites them to tune a threshold instead.
 */
const INTERNAL_TERMS = /\b(shape|unitShare|unit share|variant overlap|fence|jaccard|containment|cluster|core role)\b/i;

let fixture: Fixture;
let home: string;
let repos: string[];

beforeEach(() => {
  fixture = createFixture();
  const { api, app } = seedStandardHistory(fixture);
  repos = [api.path, app.path];
  home = mkdtempSync(join(tmpdir(), "handbook-mine-"));
});

afterEach(() => {
  fixture.cleanup();
  rmSync(home, { recursive: true, force: true });
});

function capture(): { lines: string[]; log: (l: string) => void; error: (l: string) => void } {
  const lines: string[] = [];
  return { lines, log: (l) => lines.push(l), error: (l) => lines.push(l) };
}

describe("listing the work a repository repeats", () => {
  it("given a history, when it is listed, then the same list comes back every time", async () => {
    // given one history read twice
    const first = capture();
    const second = capture();
    // when it is listed both times
    await runMineCommand(["list", "--repo", repos[1]!], { cwd: repos[0], home, ...first, options: FIXTURE_THRESHOLDS });
    await runMineCommand(["list", "--repo", repos[1]!], { cwd: repos[0], home, ...second, options: FIXTURE_THRESHOLDS });
    // then nothing about it moves between runs
    expect(first.lines.join("\n")).toBe(second.lines.join("\n"));
    expect(first.lines.join("\n")).toContain("Repeating work found in");
  });

  it("given a listing, when it runs, then no model is called", async () => {
    // given a runner that fails the test if anything reaches it
    let calls = 0;
    const out = capture();
    const run = async () => {
      calls += 1;
      return "";
    };
    // when the list is printed
    const code = await runMineCommand(["list"], { cwd: repos[0], home, ...out, run, options: FIXTURE_THRESHOLDS });
    // then the list is free: history was read and nothing was sent
    expect(code).toBe(0);
    expect(calls).toBe(0);
  });

  it("given a listing, when it is read, then it carries no word from the engine's own vocabulary", async () => {
    // given the screen a user actually meets
    const out = capture();
    await runMineCommand(["list", "--repo", repos[1]!], { cwd: repos[0], home, ...out, options: FIXTURE_THRESHOLDS });
    const screen = out.lines.join("\n");
    // when it is scanned for the words that belong behind the command
    const found = screen.match(INTERNAL_TERMS);
    // then there are none
    expect(found?.[0] ?? null).toBeNull();
  });

  it("given a history with nothing repeated, when it is listed, then it says so rather than showing an empty list", () => {
    // given no repeating work at all
    // when the empty list is formatted
    const screen = formatWorkflowList([], 1);
    // then the reader is told that is an answer, not a failure
    expect(screen).toContain("No repeating work found");
    expect(screen).toContain("not a failure");
  });

  it("given the same work found twice, when it is listed, then the repeat is marked rather than offered again", () => {
    // given two entries where the second repeats the first - built here rather than mined,
    // because the standard fixture produces no repeat and a loop over none proves nothing
    const flows: Workflow[] = [
      { rank: 1, id: "aaa", files: [{ role: "api:dto/*.kt", units: 6, of: 6, examples: ["api/dto/A.kt"] }], jobs: 6, repos: 1, people: 2, lastAt: "2026-01-01T00:00:00Z" },
      { rank: 2, id: "bbb", files: [{ role: "api:dto/*.kt", units: 4, of: 4, examples: ["api/dto/B.kt"] }], jobs: 4, repos: 1, people: 2, lastAt: "2026-01-01T00:00:00Z", sameAs: 1 },
    ];
    // when the screen is formatted
    const screen = formatWorkflowList(flows, 1);
    // then the repeat says which entry it repeats, so nobody pays for the same draft twice
    expect(screen).toContain("the same work as 1, found again at a different size");
  });

  it("given a repeat, when it is chosen for drafting, then it is refused with the number that covers it", () => {
    // given a list whose second entry repeats the first
    const flows: Workflow[] = [
      { rank: 1, id: "aaa", files: [], jobs: 6, repos: 1, people: 2, lastAt: "2026-01-01T00:00:00Z" },
      { rank: 2, id: "bbb", files: [], jobs: 4, repos: 1, people: 2, lastAt: "2026-01-01T00:00:00Z", sameAs: 1 },
    ];
    // when the repeat is the one picked
    const refusal = draftRefusal(flows, pickWorkflow(flows, "2"), "2");
    // then nothing is sent and the reader is pointed at the one draft that covers it
    expect(refusal).toContain("same work as number 1");
    // and the entry it points at drafts normally
    expect(draftRefusal(flows, pickWorkflow(flows, "1"), "1")).toBeNull();
  });

  it("given a workflow's id rather than its place, when it is chosen, then the same entry is found", () => {
    // given a list in which a number means one thing only against THAT list
    const flows: Workflow[] = [
      { rank: 1, id: "aaa", files: [], jobs: 6, repos: 1, people: 2, lastAt: "2026-01-01T00:00:00Z" },
    ];
    // when the choice names the id instead
    // then it resolves to the same entry, which is what survives a different repository set
    expect(pickWorkflow(flows, "aaa")?.rank).toBe(1);
    expect(pickWorkflow(flows, "9")).toBeUndefined();
  });
});

describe("drafting one of them", () => {
  // Shaped to what the fixture's own evidence packet offers (five map rows, two
  // repositories in order, twelve subjects, three patches), because the format gate holds a
  // draft to the evidence it was written from and a thinner fixture would measure the gate
  // rather than this command.
  const SKILL = [
    "---",
    "name: add-a-field-to-an-entity",
    'description: "Use when a ticket adds one field to an entity and that field has to reach the form. Also when the same field is wanted on the web side. Triggers: add a field, new column on an entity."',
    "---",
    "",
    "## Steps",
    "",
    "1. Add the field to the request type [map 2].",
    "2. Add it to the service that reads the request [map 3].",
    "3. Add a migration for it [map 1].",
    "4. Add the field to the web types [map 4].",
    "5. Render it on the form [map 5].",
    "",
    "## File map",
    "",
    "| file | jobs |",
    "| --- | --- |",
    "| `acme-api:dto/*Request.kt` | 6/6 |",
    "| `acme-api:service/*Service.kt` | 6/6 |",
    "| `acme-api:db/*migration.sql` | 6/6 |",
    "| `acme-app:api/*Types.ts` | 6/6 |",
    "| `acme-app:forms/*Form.tsx` | 6/6 |",
    "",
    "## Order of delivery",
    "",
    "- `acme-api` first, then `acme-app` [subject 1].",
    "",
    "## What the history could not show",
    "",
    "- Whatever review or release step happened outside git.",
    "",
    "## Verify",
    "",
    "- The service returns the new field.",
    "- The form renders it.",
    "",
    "## Common mistakes",
    "",
    "- Forgetting the migration [hunk 1].",
    "",
  ].join("\n");

  it("given a chosen workflow, when it is drafted, then it is queued for review and nothing is installed", async () => {
    // given a model that answers with a well-formed skill
    const out = capture();
    // when the first workflow is drafted
    const code = await runMineCommand(["draft", "1", "--repo", repos[1]!], {
      cwd: repos[0],
      home,
      ...out,
      run: async () => SKILL,
      options: FIXTURE_THRESHOLDS,
    });
    // then it waits in the queue, marked as mined, and no skill was written into the repository
    expect(out.lines.join("\n")).not.toContain("No draft");
    expect(code).toBe(0);
    const queued = readdirSync(candidatesDir(home));
    expect(queued).toHaveLength(1);
    const meta = readCandidateMeta(join(candidatesDir(home), queued[0]!));
    expect(meta?.origin).toBe("mine");
    expect(meta?.status).toBe("pending");
    expect(meta?.suggestedTarget).toBe("project");
    // the repository the command ran in, not the one named with --repo, by its real path
    expect(meta?.repoRoot).toBe(realpathSync(repos[0]!));
    expect(existsSync(join(repos[0]!, ".claude", "skills"))).toBe(false);
    expect(existsSync(join(repos[1]!, ".claude", "skills"))).toBe(false);
    expect(out.lines.join("\n")).toContain("sends the screened evidence");
  });

  it("given a reply the format gate refuses, when it is drafted, then nothing is queued", async () => {
    // given a model that answers with prose instead of a skill
    const out = capture();
    // when a workflow is drafted
    const code = await runMineCommand(["draft", "1"], {
      cwd: repos[0],
      home,
      ...out,
      run: async () => "I think this workflow is about adding fields.",
      options: FIXTURE_THRESHOLDS,
    });
    // then it fails closed: the queue is untouched and the reason is said
    expect(code).toBe(1);
    expect(existsSync(candidatesDir(home)) ? readdirSync(candidatesDir(home)) : []).toHaveLength(0);
    expect(out.lines.join("\n")).toContain("No draft was kept");
  });

  it("given a sibling repository on the listing, when the draft repeats it, then the same workflow is drafted", async () => {
    // given a list made across two repositories
    const out = capture();
    await runMineCommand(["list", "--repo", repos[1]!], { cwd: repos[0], home, ...out, options: FIXTURE_THRESHOLDS });
    // then the line it prints for drafting carries those repositories back
    expect(out.lines.join("\n")).toContain(`--repo ${repos[1]}`);
    // and the entry a number names is NOT the same once a repository is dropped, which is
    // why the line has to carry them: measured, not assumed
    const both = workflowsFromShapes(mineShapes(repos, FIXTURE_THRESHOLDS).shapes, 20);
    const one = workflowsFromShapes(mineShapes([repos[0]!], FIXTURE_THRESHOLDS).shapes, 20);
    expect(both[0]!.id).not.toBe(one[0]!.id);
  });

  it("given a workflow's id instead of its number, when it is drafted, then that workflow is drafted", async () => {
    // given the id the list shows, which does not move when the repository set does
    const id = workflowsFromShapes(mineShapes(repos, FIXTURE_THRESHOLDS).shapes, 20)[0]!.id;
    const out = capture();
    // when the draft names the id rather than the place
    const code = await runMineCommand(["draft", id, "--repo", repos[1]!], {
      cwd: repos[0],
      home,
      ...out,
      run: async () => SKILL,
      options: FIXTURE_THRESHOLDS,
    });
    // then it is drafted and queued, the same as naming its number
    expect(code).toBe(0);
    expect(readdirSync(candidatesDir(home))).toHaveLength(1);
  });

  function counting(reply: string): { calls: () => number; run: (prompt: string) => Promise<string> } {
    let calls = 0;
    return {
      calls: () => calls,
      run: async () => {
        calls += 1;
        return reply;
      },
    };
  }

  it("given a draft asked of the listing, when it runs, then it is refused and nothing is spent", async () => {
    // given the listing word handed the draft flag an older screen printed
    const model = counting(SKILL);
    const out = capture();
    // when it runs
    const code = await runMineCommand(["list", "--draft", "1"], {
      cwd: repos[0],
      home,
      ...out,
      run: model.run,
      options: FIXTURE_THRESHOLDS,
    });
    // then it is a usage error, the model was never called and nothing was queued
    expect(code).toBe(2);
    expect(model.calls()).toBe(0);
    expect(out.lines.join("\n")).toContain("draft <n|id>");
    expect(existsSync(candidatesDir(home))).toBe(false);
  });

  it("given a number on the draft word, when it runs, then the model is called once", async () => {
    // given a model that answers with a well-formed skill
    const model = counting(SKILL);
    const out = capture();
    // when the first workflow is drafted by its number, against the repositories it was listed from
    const code = await runMineCommand(["draft", "1", "--repo", repos[1]!], {
      cwd: repos[0],
      home,
      ...out,
      run: model.run,
      options: FIXTURE_THRESHOLDS,
    });
    // then exactly one call was made and one draft is waiting
    expect(code).toBe(0);
    expect(model.calls()).toBe(1);
    expect(readdirSync(candidatesDir(home))).toHaveLength(1);
  });

  it("given the draft word with no workflow named, when it runs, then it is refused rather than listing", async () => {
    // given a draft that names nothing
    const model = counting(SKILL);
    const out = capture();
    // when it runs
    const code = await runMineCommand(["draft"], { cwd: repos[0], home, ...out, run: model.run, options: FIXTURE_THRESHOLDS });
    // then it says what it needs, and neither lists nor calls anything
    expect(code).toBe(2);
    expect(model.calls()).toBe(0);
    expect(out.lines.join("\n")).not.toContain("Repeating work found");
  });

  it("given a number nobody listed, when it is drafted, then it is refused before any model call", async () => {
    // given a choice outside the list
    let calls = 0;
    const out = capture();
    // when it is drafted
    const code = await runMineCommand(["draft", "99"], {
      cwd: repos[0],
      home,
      ...out,
      run: async () => {
        calls += 1;
        return SKILL;
      },
      options: FIXTURE_THRESHOLDS,
    });
    // then nothing was spent on it
    expect(code).toBe(2);
    expect(calls).toBe(0);
  });
});

describe("what the review screen says a mined draft is", () => {
  it("given a mined candidate, when the queue is listed, then it is named as a draft with a measured file map", () => {
    // given a candidate the miner produced
    const listing = formatCandidateList([
      {
        slug: "add-a-field-to-an-entity",
        status: "pending",
        createdAt: new Date().toISOString(),
        scope: "project",
        description: "Use when a ticket adds one field to an entity.",
        fingerprint: "mine:abc",
        sessionId: "",
        gate: null,
        origin: "mine",
        kind: "procedure",
      },
    ]);
    // when the reviewer reads the list
    // then it says what kind of thing it is, and what it does not claim to be
    expect(listing).toContain("draft from repository history");
    expect(listing).toContain("steps the history cannot show are listed, not guessed");
  });

  it("given a mined candidate, when the queue is listed, then the whole screen reads as it is pinned here", () => {
    // given one mined candidate at a fixed moment, so the screen is a fixture rather than a clock
    const screen = formatCandidateList(
      [
        {
          slug: "add-a-field-to-an-entity",
          status: "pending",
          createdAt: "2026-10-01T09:00:00Z",
          scope: "project",
          description: "Use when a ticket adds one field to an entity.",
          fingerprint: "mine:abc",
          sessionId: "",
          cwd: "/w/acme-api",
          gate: null,
          origin: "mine",
          kind: "procedure",
        },
      ],
      Date.parse("2026-10-01T09:05:00Z"),
    );
    // when the reviewer reads it
    // then every line of it is what was agreed, not only the heading
    expect(screen).toMatchInlineSnapshot(`
      "Pending candidates (1), newest first:

        1. add-a-field-to-an-entity  [procedure]  [project]  gate n/a  ·  5m ago  ·  from acme-api
           Use when a ticket adds one field to an entity.
           draft from repository history: a skeleton and a measured file map; steps the history cannot show are listed, not guessed"
    `);
  });

  it("given a harvested candidate, when the queue is listed, then it is not relabelled as a draft", () => {
    // given an ordinary harvested lesson beside it
    const listing = formatCandidateList([
      {
        slug: "fix-npm-test",
        status: "pending",
        createdAt: new Date().toISOString(),
        scope: "team",
        description: "Use when npm test fails with a stale snapshot.",
        fingerprint: "abc",
        sessionId: "s1",
        gate: null,
        origin: "harvest",
      },
    ]);
    // when the reviewer reads the list
    // then the heading belongs only to the mined ones
    expect(listing).not.toContain("draft from repository history");
  });
});

describe("what the reviewer is told about a mined draft they act on", () => {
  function queued(overrides: Partial<CandidateMeta> = {}): string {
    const meta: CandidateMeta = {
      slug: "add-a-field-to-an-entity",
      status: "pending",
      createdAt: "2026-10-01T00:00:00Z",
      scope: "project",
      description: "Use when a ticket adds one field to an entity.",
      fingerprint: "mine:abc",
      sessionId: "",
      gate: null,
      origin: "mine",
      kind: "procedure",
      ...overrides,
    };
    const dir = join(candidatesDir(home), meta.slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\nname: ${meta.slug}\ndescription: "d"\n---\n\nSteps.\n`);
    writeCandidateMeta(dir, meta);
    return dir;
  }

  it("given a mined draft, when it is rejected for good, then it is not promised that it will never come back", () => {
    // given a mined candidate, whose workflow the list keeps showing whatever the verdict
    queued();
    // when the reviewer rejects it with --never
    const result = decideCandidate(home, "add-a-field-to-an-entity", "rejected", undefined, { mute: true });
    const said = rejectionMessage("add-a-field-to-an-entity", result, true);
    // then the message says what is true: it is only drafted again when someone picks it
    expect(said).not.toContain("will not be suggested again");
    expect(said).not.toContain("--never");
    expect(said).toContain("/handbook:mine");
  });

  it("given a harvested lesson, when it is rejected for good, then the mute it records is still what it is told", () => {
    // given a candidate whose fingerprint the harvest's sieve does read
    queued({ slug: "fix-npm-test", origin: "harvest", fingerprint: "abc123" });
    // when the reviewer rejects it with --never
    const result = decideCandidate(home, "fix-npm-test", "rejected", undefined, { mute: true });
    // then the wording it always had is unchanged
    expect(rejectionMessage("fix-npm-test", result, true)).toBe(
      'Rejected "fix-npm-test" and muted its fingerprint - this learning will not be suggested again.',
    );
  });

  it("given a draft carrying a secret, when it is shown, then the hygiene line names the pattern and the file in the trace's format", () => {
    // given a mined candidate whose reference file holds a credential
    const key = "sk-ant-api03-" + "c".repeat(95);
    const dir = queued();
    writeFileSync(join(dir, "reference.md"), `export KEY=${key}\n`);
    // when the review screen builds its hygiene lines
    const lines = hygieneLines(dir, "add-a-field-to-an-entity");
    // then one line says it, the way the identity line does, and the value is nowhere in it
    expect(lines).toEqual([
      'hygiene:   its file "reference.md" looks like it contains a secret (anthropic-api-key) - ' +
        "keeping it for yourself still works; take the credential out before it goes to a project or the team",
    ]);
    expect(lines.join("\n")).not.toContain(key);
  });

  it("given a draft carrying a trace of this machine, when it is shown, then the identity line reads as it always did", () => {
    // given a mined candidate whose body names a home directory
    const dir = queued();
    const standIn = ["", "Users", "alice", "work", "api"].join("/");
    writeFileSync(join(dir, "SKILL.md"), `---\nname: add-a-field-to-an-entity\ndescription: "d"\n---\n\nRun it in ${standIn}.\n`);
    // when the review screen builds its hygiene lines
    const lines = hygieneLines(dir, "add-a-field-to-an-entity");
    // then the line moved out of the command is word for word the one it printed
    expect(lines).toEqual([
      'hygiene:   its file "SKILL.md" carries a trace of this machine (home-path) - approving this to a ' +
        "project or to the team is refused; keeping it for yourself still works, or take the trace out first",
    ]);
  });
});

describe("the command's own words", () => {
  it("given every line the command can print, when they are scanned, then none names the employer's vocabulary", async () => {
    // given the screens a user meets, including the failures
    const out = capture();
    await runMineCommand(["list"], { cwd: repos[0], home, ...out, options: FIXTURE_THRESHOLDS });
    await runMineCommand(["list", "--limit", "x"], { cwd: repos[0], home, ...out });
    await runMineCommand(["draft", "99"], { cwd: repos[0], home, ...out, options: FIXTURE_THRESHOLDS });
    await runMineCommand(["list", "--draft", "1"], { cwd: repos[0], home, ...out, options: FIXTURE_THRESHOLDS });
    await runMineCommand(["list", "--help"], { cwd: repos[0], home, ...out });
    const screens = out.lines.join("\n");
    // when they are read against the command's own description too
    const commandMd = readFileSync(new URL("../../commands/mine.md", import.meta.url), "utf8");
    // then neither carries a word from the engine's vocabulary
    expect(screens.match(INTERNAL_TERMS)?.[0] ?? null).toBeNull();
    expect(commandMd.match(INTERNAL_TERMS)?.[0] ?? null).toBeNull();
  });
});
