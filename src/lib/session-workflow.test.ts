import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectWorkflow,
  finishWorkflowSession,
  loadMinedRecord,
  minedRecordFile,
  recordWorkflowEvent,
  repositoryOf,
  WORKFLOW_LINE_FIELDS,
  workflowsFile,
} from "./session-workflow.js";
import type { MinedRecord, RepoFile, WorkflowDeps, WorkflowLine } from "./session-workflow.js";
import { loadSessionState } from "./session-state.js";
import { readCounters } from "./counters.js";
import { runMineCommand } from "./mine-run.js";
import { createFixture, seedStandardHistory } from "./mine-fixture.js";
import type { Fixture } from "./mine-fixture.js";
import type { HookInput } from "./hook-io.js";
import type { MineOptions } from "./mine.js";

const FIXTURE_THRESHOLDS: MineOptions = { minRecurrence: 5, minProposers: 5, rareRoleUnits: 3 };

let fixture: Fixture;
let api: string;
let app: string;
let worktree: string;
let ignoring: string;
let minedHome: string;
let home: string;

const deps = (overrides: Partial<WorkflowDeps> = {}): WorkflowDeps => ({
  entrypoint: "cli",
  host: { names: [] },
  userHome: fixture.root,
  ...overrides,
});

beforeAll(async () => {
  fixture = createFixture();
  const repos = seedStandardHistory(fixture);
  api = repos.api.path;
  app = repos.app.path;
  worktree = join(fixture.root, "wt-api");
  execFileSync("git", ["-C", api, "worktree", "add", "-q", "-b", "TEAM-77-refund", worktree], { stdio: "ignore" });
  ignoring = join(fixture.root, "acme-notes");
  mkdirSync(ignoring);
  execFileSync("git", ["-C", ignoring, "init", "-q"], { stdio: "ignore" });
  writeFileSync(join(ignoring, ".gitignore"), "notes/\n");
  minedHome = mkdtempSync(join(tmpdir(), "handbook-mined-"));
  await runMineCommand(["list", "--repo", app], { cwd: api, home: minedHome, log: () => {}, options: FIXTURE_THRESHOLDS });
});

afterAll(() => {
  fixture.cleanup();
  rmSync(minedHome, { recursive: true, force: true });
});

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function withMinedRecord(): MinedRecord {
  mkdirSync(home, { recursive: true });
  copyFileSync(minedRecordFile(minedHome), minedRecordFile(home));
  return loadMinedRecord(home)!;
}

function edit(path: string, overrides: Partial<HookInput> = {}): HookInput {
  return { session_id: "s1", cwd: api, hook_event_name: "PostToolUse", tool_name: "Edit", tool_input: { file_path: path }, ...overrides };
}

function bash(command: string, ok = true, overrides: Partial<HookInput> = {}): HookInput {
  const result = ok
    ? { hook_event_name: "PostToolUse", tool_response: { stdout: "", stderr: "", interrupted: false } }
    : { hook_event_name: "PostToolUseFailure", error: "Exit code 1" };
  return { session_id: "s1", cwd: api, tool_name: "Bash", tool_input: { command }, ...result, ...overrides };
}

function lines(): WorkflowLine[] {
  if (!existsSync(workflowsFile(home))) return [];
  return readFileSync(workflowsFile(home), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const HIDDEN_WORKFLOW_FILES = () => [
  join(api, "src/dto/CreateRefundRequest.kt"),
  join(api, "src/service/RefundService.kt"),
  join(api, "db/migration.sql"),
  join(app, "src/api/refundTypes.ts"),
  join(app, "src/forms/RefundForm.tsx"),
];

describe("detectWorkflow", () => {
  const record: MinedRecord = {
    version: 1,
    at: "2026-01-01T00:00:00.000Z",
    repos: [
      { root: "/r/acme-api", label: "acme-api", family: "acme-api" },
      { root: "/r/acme-app", label: "acme-app", family: "acme-app" },
    ],
    resolver: { mirrors: [], templates: [], areas: [], compiled: [] },
    prefixes: [],
    shapes: [{ id: "shape0000001", core: ["acme-api:dto/*Request.kt", "acme-api:service/*Service.kt", "acme-app:api/*Types.ts"], recurrence: 6 }],
  };
  const file = (repo: string, path: string): RepoFile => ({ repo, checkout: repo, path });

  it("given files covering most of a mined workflow's core, when detected, then it is that shape", () => {
    const files = [file("/r/acme-api", "src/dto/CreateRefundRequest.kt"), file("/r/acme-app", "src/api/refundTypes.ts")];

    expect(detectWorkflow(files, record)).toMatchObject({ match: "shape", shape: "shape0000001" });
  });

  it("given two roles that no mined workflow holds, when detected, then it is a candidate", () => {
    const files = [file("/r/acme-api", "src/util/HelperUtil.kt"), file("/r/acme-api", "README.md")];

    expect(detectWorkflow(files, record)).toMatchObject({ match: "candidate", shape: null });
  });

  it("given code in one repository and only a report in another, when detected, then the report adds no role", () => {
    const files = [file("/r/acme-api", "src/service/RefundService.kt"), file("/r/acme-notes", "reports/RefundReport.md")];

    expect(detectWorkflow(files, record)).toBeNull();
  });

  it("given one role and its test, when detected, then it is not a workflow", () => {
    const files = [file("/r/acme-api", "src/service/RefundService.kt"), file("/r/acme-api", "src/test/RefundServiceTest.kt")];

    expect(detectWorkflow(files, record)).toBeNull();
  });
});

describe("the mined record", () => {
  it("given a listing, when it ran, then the record names the mined repositories and the workflow it found", () => {
    const record = loadMinedRecord(minedHome)!;

    expect(record.repos.map((r) => r.root).sort()).toEqual([api, app].map((p) => realpathSync(p)).sort());
    expect(record.shapes.some((s) => s.core.includes("acme-api:dto/*Request.kt"))).toBe(true);
  });

  it("given detection switched off, when a listing runs, then no record is kept", async () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ sessions: { detect: false } }));

    await runMineCommand(["list"], { cwd: api, home, log: () => {}, options: FIXTURE_THRESHOLDS });

    expect(existsSync(minedRecordFile(home))).toBe(false);
  });
});

describe("S1: a green check, then a commit", () => {
  it("given a session doing a mined workflow, when its check passes and it commits, then one S1 line names that workflow", () => {
    const record = withMinedRecord();
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());
    recordWorkflowEvent(bash("npm test"), home, deps());

    const line = recordWorkflowEvent(bash('git commit -m "TEAM-99 add refund"'), home, deps());

    expect(line).toMatchObject({ signal: "S1", match: "shape", rolesEdited: 5 });
    expect(record.shapes.find((s) => s.id === line!.shape)!.core).toContain("acme-api:dto/*Request.kt");
    expect(lines()).toHaveLength(1);
  });

  it("given a check piped into tail, when the session commits, then S1 fires on the line's status and says the check's own status was hidden", () => {
    withMinedRecord();
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());
    recordWorkflowEvent(bash("npm test 2>&1 | tail -5"), home, deps());

    const line = recordWorkflowEvent(bash("git commit -m x"), home, deps());

    expect(line).toMatchObject({ signal: "S1", maskedCheck: true });
  });

  it("given a commit with no check since the last write, when it lands, then nothing fires", () => {
    withMinedRecord();
    recordWorkflowEvent(bash("npm test"), home, deps());
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());

    expect(recordWorkflowEvent(bash("git commit -m x"), home, deps())).toBeNull();
    expect(lines()).toEqual([]);
  });

  it("given a failing check, when the session commits, then nothing fires", () => {
    withMinedRecord();
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());
    recordWorkflowEvent(bash("npm test", false), home, deps());

    expect(recordWorkflowEvent(bash("git commit -m x"), home, deps())).toBeNull();
  });
});

describe("S2: the session ends after a green check", () => {
  it("given a green check after the last write, when the session ends, then one S2 line is written and the session is counted", () => {
    withMinedRecord();
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());
    recordWorkflowEvent(bash("npx vitest run"), home, deps());

    const line = finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps());

    expect(line).toMatchObject({ signal: "S2", match: "shape" });
    expect(readCounters(home).workflowSessions).toBe(1);
  });

  it("given a write after the last check, when the session ends, then nothing fires but the session and its detection are still counted", () => {
    withMinedRecord();
    recordWorkflowEvent(bash("npm test"), home, deps());
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());

    expect(finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps())).toBeNull();
    expect(readCounters(home)).toMatchObject({ workflowSessions: 1, workflowDetectedShape: 1, workflowDetectedCandidate: 0 });
    expect(lines()).toEqual([]);
  });
});

describe("what one line holds", () => {
  it("given a recognized session, when its line is written, then it has exactly the pinned fields and no path, command, name or ticket", () => {
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());
    recordWorkflowEvent(bash("npm test"), home, deps());
    recordWorkflowEvent(bash('git commit -m "TEAM-99 add refund"'), home, deps());

    const raw = readFileSync(workflowsFile(home), "utf8");
    const line = JSON.parse(raw) as WorkflowLine;

    expect(Object.keys(line)).toEqual([...WORKFLOW_LINE_FIELDS]);
    expect(line).toMatchObject({ signal: "S1", match: "candidate", shape: null, rolesEdited: 5, signals: 0, ticket: null, maskedCheck: false });
    for (const hash of [line.session, ...line.roles, ...line.repos]) expect(hash).toMatch(/^[0-9a-f]{16}$/);
    for (const forbidden of [fixture.root, "acme", "Refund", "dto", "Service", "npm test", "git commit", "TEAM-99", "s1"]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("given a session on a ticket branch in a linked worktree, when recorded, then the worktree folds onto its repository and the ticket is a hash", () => {
    recordWorkflowEvent(edit(join(worktree, "src/dto/CreateRefundRequest.kt")), home, deps());
    recordWorkflowEvent(edit(join(worktree, "db/migration.sql")), home, deps());
    recordWorkflowEvent(edit(join(api, "src/util/HelperUtil.kt")), home, deps());
    recordWorkflowEvent(bash("./gradlew test", true, { cwd: worktree }), home, deps());

    const line = finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps())!;

    expect(repositoryOf(worktree)!.repo).toBe(realpathSync(api));
    expect(line.repos).toHaveLength(1);
    expect(line.ticket).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(workflowsFile(home), "utf8")).not.toContain("TEAM-77");
  });

  it("given a file with an unusual name under a home directory, when recorded, then neither the name nor its directories reach the line", () => {
    const userHome = join(fixture.root, "home-fixture");
    const project = join(userHome, "wobbleplex-proj");
    mkdirSync(project, { recursive: true });
    execFileSync("git", ["-C", project, "init", "-q"], { stdio: "ignore" });
    const unusual = deps({ userHome });
    recordWorkflowEvent(edit(join(project, "Zyxquorbl"), { cwd: project }), home, unusual);
    recordWorkflowEvent(edit(join(project, "src/Wobbleplex/ThingZyxquorbl.kt"), { cwd: project }), home, unusual);
    recordWorkflowEvent(bash("echo note > ~/wobbleplex-proj/docs/zyxquorbl-notes.md && make test", true, { cwd: project }), home, unusual);

    const line = finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, unusual);
    const raw = readFileSync(workflowsFile(home), "utf8").toLowerCase();

    expect(line).toMatchObject({ match: "candidate", rolesEdited: 3 });
    for (const forbidden of ["zyxquorbl", "wobbleplex", "home-fixture", "notes", "thing"]) expect(raw).not.toContain(forbidden);
  });
});

describe("where the writes come from", () => {
  it("given files written only through the shell, when the session ends green, then they count as the session's writes", () => {
    recordWorkflowEvent(bash(`cat > ${join(api, "src/dto/CreateRefundRequest.kt")} <<'EOF'\nclass A(val b: Int) > 0\nEOF`), home, deps());
    recordWorkflowEvent(bash(`sed -i '' 's/a/b/' src/api/refundTypes.ts`, true, { cwd: app }), home, deps());
    recordWorkflowEvent(bash("npm run build"), home, deps());

    const line = finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps());

    expect(line).toMatchObject({ signal: "S2", rolesEdited: 2 });
    expect(line!.repos).toHaveLength(2);
  });

  it("given a subagent writing one file and the main session another, when the session ends, then they make one session with one line", () => {
    const subagent = { agent_id: "agent-1", agent_type: "general-purpose" } as Partial<HookInput>;
    recordWorkflowEvent(edit(join(api, "src/dto/CreateRefundRequest.kt"), subagent), home, deps());
    recordWorkflowEvent(edit(join(app, "src/api/refundTypes.ts")), home, deps());
    recordWorkflowEvent(bash("npm test", true, subagent), home, deps());
    recordWorkflowEvent(edit(join(api, "src/util/HelperUtil.kt"), { session_id: "s2" }), home, deps());

    finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps());
    finishWorkflowSession({ session_id: "s2" }, loadSessionState("s2", home), home, deps());

    expect(lines()).toHaveLength(1);
    expect(lines()[0]).toMatchObject({ rolesEdited: 2 });
    expect(readCounters(home).workflowSessions).toBe(2);
  });

  it("given a note in a directory git ignores, when the session ends, then it is not one of the session's roles", () => {
    recordWorkflowEvent(edit(join(ignoring, "notes/plan.md"), { cwd: ignoring }), home, deps());
    recordWorkflowEvent(edit(join(ignoring, "src/PlanService.kt"), { cwd: ignoring }), home, deps());
    recordWorkflowEvent(bash("make test", true, { cwd: ignoring }), home, deps());

    expect(finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps())).toBeNull();
  });
});

describe("what is not recorded", () => {
  it("given a role carrying the account name, when the session would be recognized, then no line is written and the skip is counted", () => {
    recordWorkflowEvent(edit(join(api, "src/quinella/QuinellaService.kt")), home, deps());
    recordWorkflowEvent(edit(join(api, "src/dto/CreateRefundRequest.kt")), home, deps());
    recordWorkflowEvent(bash("npm test"), home, deps());

    const line = finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps({ host: { names: ["quinella"] } }));

    expect(line).toBeNull();
    expect(existsSync(workflowsFile(home))).toBe(false);
    expect(readCounters(home).workflowSkippedHygiene).toBe(1);
  });

  it("given a path carrying someone's home directory, when the session would be recognized, then no line is written and the skip is counted", () => {
    recordWorkflowEvent(edit(join(api, "fixtures/home/quinella/RefundSample.kt")), home, deps());
    recordWorkflowEvent(edit(join(api, "src/dto/CreateRefundRequest.kt")), home, deps());
    recordWorkflowEvent(bash("npm test"), home, deps());

    expect(finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps())).toBeNull();
    expect(existsSync(workflowsFile(home))).toBe(false);
    expect(readCounters(home).workflowSkippedHygiene).toBe(1);
  });

  it("given a path carrying a token, when the session would be recognized, then no line is written and the skip is counted", () => {
    const token = `glpat-${"x1".repeat(12)}`;
    recordWorkflowEvent(edit(join(api, `src/${token}/ConfigService.kt`)), home, deps());
    recordWorkflowEvent(edit(join(api, "src/dto/CreateRefundRequest.kt")), home, deps());
    recordWorkflowEvent(bash("npm test"), home, deps());
    recordWorkflowEvent(bash("git commit -m x"), home, deps());

    expect(existsSync(workflowsFile(home))).toBe(false);
    expect(readCounters(home).workflowSkippedHygiene).toBe(1);
    expect(loadSessionState("s1", home).workflow?.fired).toEqual(["S1"]);
  });

  it("given detection switched off, when a session writes, checks and ends, then nothing is kept or counted", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ sessions: { detect: false } }));
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, deps());
    recordWorkflowEvent(bash("npm test"), home, deps());
    recordWorkflowEvent(bash("git commit -m x"), home, deps());

    finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, deps());

    expect(loadSessionState("s1", home).workflow).toBeUndefined();
    expect(existsSync(workflowsFile(home))).toBe(false);
    expect(readCounters(home)).toMatchObject({ workflowSessions: 0, workflowSkippedAutonomous: 0, workflowDetectedShape: 0, workflowDetectedCandidate: 0 });
  });

  it("given a session nobody drives, when it writes and ends, then it is skipped and counted as such", () => {
    const scripted = deps({ entrypoint: "sdk-cli" });
    for (const path of HIDDEN_WORKFLOW_FILES()) recordWorkflowEvent(edit(path), home, scripted);
    recordWorkflowEvent(bash("npm test"), home, scripted);

    finishWorkflowSession({ session_id: "s1" }, loadSessionState("s1", home), home, scripted);

    expect(existsSync(workflowsFile(home))).toBe(false);
    expect(readCounters(home)).toMatchObject({ workflowSessions: 0, workflowSkippedAutonomous: 1 });
  });
});
