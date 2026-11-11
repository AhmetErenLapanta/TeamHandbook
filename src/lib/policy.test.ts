import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { PolicyRule } from "./policy.js";
import { claudeDenyRules, denialMessage, patternMatches, policyCacheFile, policyDenial, policiesProblem, policyNotice, policyOrigin, rulesProblem, teamPolicy } from "./policy.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const deny = (action: PolicyRule["action"], resource: string, reason = "retired"): PolicyRule => ({ action, resource, effect: "deny", reason });

interface Machine {
  userHome: string;
  home: string;
  root: string;
  copy: string;
}

/** A developer's machine joined to acme-skills, whose copy Claude Code keeps under ~/.claude/plugins/marketplaces, with `team` as its team file. */
function machine(team: unknown): Machine {
  const userHome = mkdtempSync(join(tmpdir(), "policy-"));
  dirs.push(userHome);
  const home = join(userHome, ".teamhandbook");
  const root = join(userHome, ".claude", "plugins", "marketplaces");
  const copy = join(root, "acme-skills");
  mkdirSync(join(copy, ".claude-plugin"), { recursive: true });
  writeFileSync(join(copy, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme-skills" }));
  writeTeam(copy, team);
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ team: { repoUrl: "https://git.example.com/acme/acme-skills.git", marketplaceName: "acme-skills" } }));
  return { userHome, home, root, copy };
}

function writeTeam(copy: string, team: unknown): void {
  writeFileSync(join(copy, ".teamhandbook.json"), typeof team === "string" ? team : JSON.stringify(team, null, 2) + "\n");
}

/** A team file's policies: one named group holding `rules`. */
const one = (rules: PolicyRule[]) => [{ id: "pol_retire", name: "Retire what moved", rules }];

const call = (tool_name: string, tool_input: Record<string, unknown> = {}) => ({ tool_name, tool_input, cwd: "/work/payments" });

describe("the grammar of a team's policy", () => {
  it("given rules of each kind, when they are checked, then they are a policy", () => {
    expect(
      rulesProblem([
        deny("mcp.use", "mcp:warehouse"),
        deny("mcp.use", "mcp:tracker/deleteIssue"),
        deny("skill.use", "skill:release-*"),
        deny("tool.use", "tool:Bash:git push *"),
        deny("tool.use", "tool:Edit:*.env"),
        deny("tool.use", "tool:WebFetch:*"),
      ]),
    ).toBeNull();
    expect(policiesProblem(one([deny("mcp.use", "mcp:warehouse")]))).toBeNull();
    expect(policiesProblem([])).toBeNull();
  });

  it.each([
    ["no rules", [], "it has no rules"],
    ["more rules than twenty rules of twenty resources", Array.from({ length: 401 }, () => deny("mcp.use", "mcp:x")), "it has more than 400 rules"],
    ["an allow", [{ ...deny("mcp.use", "mcp:x"), effect: "allow" }], 'rule 1: its effect is not "deny": a policy only takes away, and a capability is given by adding it in a reviewed request'],
    ["an unknown action", [{ ...deny("mcp.use", "mcp:x"), action: "provider.use" }], "rule 1: its action is not one of mcp.use, skill.use, tool.use"],
    ["an action against another kind", [deny("skill.use", "mcp:x")], "rule 1: a skill.use rule names skill:<skill>, in letters, digits, _ . : - and *"],
    ["a server with a slash too many", [deny("mcp.use", "mcp:a/b/c")], "rule 1: an mcp.use rule names mcp:<server> or mcp:<server>/<tool>, in letters, digits, _ . - and *"],
    ["an unknown tool", [deny("tool.use", "tool:Shell:rm *")], 'rule 1: a tool.use rule names one of Bash, Read, Edit, Glob, Grep, WebFetch, WebSearch, not "Shell"'],
    ["a tool with no pattern", [deny("tool.use", "tool:Bash")], "rule 1: a tool.use rule names tool:<tool>:<pattern>"],
    ["an empty reason", [deny("mcp.use", "mcp:x", " ")], "rule 1: its reason is empty"],
    ["a reason that breaks the line", [deny("mcp.use", "mcp:x", "retired\n\u001b[31mallowed")], "rule 1: its reason carries a control character"],
    ["a key a rule does not take", [{ ...deny("mcp.use", "mcp:x"), audience: "backend" }], 'rule 1: it has "audience", which a rule does not take'],
    ["a secret in a pattern", [deny("tool.use", "tool:Bash:curl -H 'Authorization: Bearer dGhpcy1pcy1hLXZlcnktbG9uZy10b2tlbg' *")], "rule 1: it looks like it contains a secret (bearer-token)"],
  ])("given %s, when it is checked, then the problem names the rule and what is wrong", (_case, rules, problem) => {
    expect(rulesProblem(rules)).toBe(problem);
  });

  it.each([
    ["not a list", { id: "pol_x" }, "policies is not a list"],
    ["a policy with no id", [{ name: "x", rules: [deny("mcp.use", "mcp:x")] }], "policy 1 has no id of letters, digits, _ and -"],
    ["two policies with one id", [...one([deny("mcp.use", "mcp:x")]), ...one([deny("mcp.use", "mcp:y")])], "policy 2 repeats the id pol_retire"],
    ["a policy with an audience", [{ ...one([deny("mcp.use", "mcp:x")])[0], audience: { kind: "members" } }], 'policy 1 has "audience", which a policy does not take'],
    ["a policy with a bad rule", one([{ ...deny("mcp.use", "mcp:x"), action: "provider.use" } as unknown as PolicyRule]), "policy 1 (pol_retire): rule 1: its action is not one of mcp.use, skill.use, tool.use"],
  ])("given %s, when a team file's policies are checked, then the problem names the policy", (_case, policies, problem) => {
    expect(policiesProblem(policies)).toBe(problem);
  });
});

describe("which call a rule blocks", () => {
  it("given a pattern, when it is matched, then * spans any run of characters and the rest matches itself over the whole value", () => {
    expect(patternMatches("git push *", "git push origin main")).toBe(true);
    expect(patternMatches("*.env", "/work/payments/config/.env")).toBe(true);
    expect(patternMatches("git push", "git push --force")).toBe(false);
    expect(patternMatches("a.b", "aXb")).toBe(false);
  });

  it("given a server rule, when a tool of it is called as the user configured it or as a plugin ships it, then both are blocked and another server is not", () => {
    const rules = [deny("mcp.use", "mcp:warehouse")];
    expect(policyDenial(rules, call("mcp__warehouse__query"))).toEqual(rules[0]);
    expect(policyDenial(rules, call("mcp__plugin_acme-skills_warehouse__query"))).toEqual(rules[0]);
    expect(policyDenial(rules, call("mcp__plugin_acme-skills_tracker__getIssue"))).toBeNull();
    expect(policyDenial(rules, call("mcp__warehouse-staging__query"))).toBeNull();
  });

  it("given a rule for one tool of a server, when that tool and another are called, then only that one is blocked", () => {
    const rules = [deny("mcp.use", "mcp:tracker/deleteIssue")];
    expect(policyDenial(rules, call("mcp__tracker__deleteIssue"))).toEqual(rules[0]);
    expect(policyDenial(rules, call("mcp__tracker__getIssue"))).toBeNull();
  });

  it("given a skill rule, when the skill is called by the team plugin's name, by another plugin's or bare, then each is blocked", () => {
    const rules = [deny("skill.use", "skill:release-checklist")];
    expect(policyDenial(rules, call("Skill", { skill: "acme-skills:release-checklist" }))).toEqual(rules[0]);
    expect(policyDenial(rules, call("Skill", { skill: "release-checklist" }))).toEqual(rules[0]);
    expect(policyDenial(rules, call("Skill", { skill: "acme-skills:release-notes" }))).toBeNull();
  });

  it("given a shell rule, when the command is one of several on a line, behind a wrapper or alone, then it is blocked", () => {
    const rules = [deny("tool.use", "tool:Bash:git push *")];
    expect(policyDenial(rules, call("Bash", { command: "git push origin main" }))).toEqual(rules[0]);
    expect(policyDenial(rules, call("Bash", { command: "npm test && git push --force" }))).toEqual(rules[0]);
    expect(policyDenial(rules, call("Bash", { command: "GIT_TRACE=1 git push origin" }))).toEqual(rules[0]);
    expect(policyDenial(rules, call("Bash", { command: "git status" }))).toBeNull();
  });

  it("given an Edit rule, when a matching file is written by any tool that changes files, then each is blocked, and reading it is not", () => {
    const rules = [deny("tool.use", "tool:Edit:*.env")];
    for (const tool of ["Edit", "MultiEdit", "Write"]) expect(policyDenial(rules, call(tool, { file_path: "/work/payments/.env" })), tool).toEqual(rules[0]);
    expect(policyDenial(rules, call("Edit", { file_path: "config/.env" }))).toEqual(rules[0]);
    expect(policyDenial(rules, call("Read", { file_path: "/work/payments/.env" }))).toBeNull();
    expect(policyDenial(rules, call("Edit", { file_path: "/work/payments/README.md" }))).toBeNull();
  });

  it("given a rule for a directory, when a file in it is named relative to the session's directory, then it is blocked", () => {
    const rules = [deny("tool.use", "tool:Edit:/work/payments/migrations/*")];
    expect(policyDenial(rules, call("Write", { file_path: "migrations/0042_drop.sql" }))).toEqual(rules[0]);
    expect(policyDenial(rules, call("Write", { file_path: "docs/0042.md" }))).toBeNull();
  });

  it("given two rules that match one call, when it is decided, then the one written last gives the reason", () => {
    const rules = [deny("mcp.use", "mcp:*", "no MCP in this repository"), deny("mcp.use", "mcp:warehouse", "the warehouse moved")];
    expect(policyDenial(rules, call("mcp__warehouse__query"))?.reason).toBe("the warehouse moved");
  });
});

describe("the policy this machine holds", () => {
  it("given a team file with a valid policy, when it is read, then its rules are in force and kept as the last good copy", () => {
    // given
    const m = machine({ commitPrefix: "", policies: one([deny("mcp.use", "mcp:warehouse")]) });

    // when
    const policy = teamPolicy(m.home, m.root, () => "2026-10-25T09:00:00.000Z");

    // then
    expect(policy).toEqual({ source: "team", rules: [deny("mcp.use", "mcp:warehouse")], copy: m.copy });
    expect(JSON.parse(readFileSync(policyCacheFile(m.home), "utf8"))).toEqual({ marketplace: "acme-skills", rules: [deny("mcp.use", "mcp:warehouse")], savedAt: "2026-10-25T09:00:00.000Z" });
  });

  it.each([
    ["a team file that is not JSON", "{ policy: [", ".teamhandbook.json in the team's copy is not a JSON object"],
    ["a policy with an allow", { policies: one([{ ...deny("mcp.use", "mcp:warehouse"), effect: "allow" } as unknown as PolicyRule]) }, 'the policies in .teamhandbook.json are not valid: policy 1 (pol_retire): rule 1: its effect is not "deny": a policy only takes away, and a capability is given by adding it in a reviewed request'],
  ])("given %s after a good one, when it is read, then the last good rules stay in force and the session is told why", (_case, broken, problem) => {
    // given
    const m = machine({ policies: one([deny("mcp.use", "mcp:warehouse")]) });
    teamPolicy(m.home, m.root, () => "2026-10-24T09:00:00.000Z");
    writeTeam(m.copy, broken);

    // when
    const policy = teamPolicy(m.home, m.root);

    // then
    expect(policy).toEqual({ source: "cache", rules: [deny("mcp.use", "mcp:warehouse")], problem, savedAt: "2026-10-24T09:00:00.000Z", copy: m.copy });
    expect(policyNotice(policy)).toBe(`TeamHandbook: ${problem}. The team's policy as last read on 2026-10-24 stays in force (1 rule(s)) until the team's copy carries a valid one.`);
  });

  it("given a broken team file and no good one read before, when it is read, then nothing is blocked and the session is told", () => {
    // given
    const m = machine("{ policy: [");

    // when
    const policy = teamPolicy(m.home, m.root);

    // then
    expect(policy.rules).toEqual([]);
    expect(policyNotice(policy)).toBe("TeamHandbook: .teamhandbook.json in the team's copy is not a JSON object. No valid policy was read on this machine before, so nothing is blocked until the team's copy carries one.");
  });

  it("given a copy whose policy was removed by a merge, when it is read, then nothing is blocked and the cache follows", () => {
    // given
    const m = machine({ policies: one([deny("mcp.use", "mcp:warehouse")]) });
    teamPolicy(m.home, m.root);
    writeTeam(m.copy, { policies: [] });

    // when
    const policy = teamPolicy(m.home, m.root);

    // then
    expect(policy).toEqual({ source: "team", rules: [], copy: m.copy });
    expect(JSON.parse(readFileSync(policyCacheFile(m.home), "utf8")).rules).toEqual([]);
  });

  it("given a machine that joined another team whose file is broken, when the policy is read, then the first team's cached rules are not in force", () => {
    // given
    const m = machine({ policies: one([deny("mcp.use", "mcp:warehouse")]) });
    teamPolicy(m.home, m.root);
    const other = join(m.root, "platform-skills");
    mkdirSync(join(other, ".claude-plugin"), { recursive: true });
    writeFileSync(join(other, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "platform-skills" }));
    writeTeam(other, "{ broken");
    writeFileSync(join(m.home, "config.json"), JSON.stringify({ team: { repoUrl: "https://git.example.com/acme/platform-skills.git", marketplaceName: "platform-skills" } }));

    // when
    const policy = teamPolicy(m.home, m.root);

    // then
    expect([policy.source, policy.rules]).toEqual(["none", []]);
  });

  it("given a machine that left the team, when the policy is read, then the cached rules of the old team are not in force", () => {
    // given
    const m = machine({ policies: one([deny("mcp.use", "mcp:warehouse")]) });
    teamPolicy(m.home, m.root);
    writeFileSync(join(m.home, "config.json"), "{}");

    // when / then
    expect(teamPolicy(m.home, m.root)).toEqual({ source: "none", rules: [] });
  });
});

describe("where a blocked call says its rule came from", () => {
  it("given a copy that is a git checkout, when a rule is looked up, then the commit that added it is named", () => {
    // given
    const m = machine({ commitPrefix: "" });
    const git = (...args: string[]) => execFileSync("git", ["-C", m.copy, "-c", "user.name=Grace Example", "-c", "user.email=grace@example.invalid", ...args], { encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", "-A");
    git("commit", "--quiet", "-m", "scaffold");
    writeTeam(m.copy, { commitPrefix: "", policies: one([deny("mcp.use", "mcp:warehouse", "the warehouse moved")]) });
    git("commit", "--quiet", "-am", "policy: retire the warehouse server");
    const added = git("rev-parse", "--short", "HEAD");
    writeTeam(m.copy, { commitPrefix: "OPS", policies: one([deny("mcp.use", "mcp:warehouse", "the warehouse moved")]) });
    git("commit", "--quiet", "-am", "a later change to the team file");

    // when
    const origin = policyOrigin(m.copy, deny("mcp.use", "mcp:warehouse"));

    // then
    expect(origin).toBe(added);
    expect(denialMessage(deny("mcp.use", "mcp:warehouse", "the warehouse moved"), origin)).toBe(`Blocked by the team's policy: the warehouse moved (mcp.use mcp:warehouse, added in ${added}).`);
    expect(policyOrigin(join(m.userHome, "not-a-checkout"), deny("mcp.use", "mcp:warehouse"))).toBeNull();
  });
});

describe("the hook a session runs before every tool call", () => {
  /** The built hook, run as Claude Code runs it: the call on stdin, this machine's home in HOME. */
  function hook(m: Machine, input: Record<string, unknown>) {
    const run = spawnSync(process.execPath, [join(repoRoot, "dist", "pre-tool-use.js")], {
      input: JSON.stringify({ session_id: "s1", hook_event_name: "PreToolUse", cwd: "/work/payments", ...input }),
      env: { PATH: process.env.PATH, HOME: m.userHome },
      encoding: "utf8",
    });
    return { code: run.status, out: run.stdout ? JSON.parse(run.stdout) : null };
  }

  it("given a team copy that retires a server and a skill, when a session calls each and an allowed tool, then the two are denied with the team's reason and the third goes ahead", () => {
    // given
    const m = machine({ policies: one([deny("mcp.use", "mcp:warehouse", "the warehouse moved to the data team's server"), deny("skill.use", "skill:release-checklist", "replaced by release-train")]) });

    // when
    const server = hook(m, { tool_name: "mcp__plugin_acme-skills_warehouse__query", tool_input: { sql: "select 1" } });
    const skill = hook(m, { tool_name: "Skill", tool_input: { skill: "acme-skills:release-checklist" } });
    const allowed = hook(m, { tool_name: "Read", tool_input: { file_path: "/work/payments/README.md" } });

    // then
    expect(server).toEqual({
      code: 0,
      out: { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Blocked by the team's policy: the warehouse moved to the data team's server (mcp.use mcp:warehouse)." } },
    });
    expect(skill.out.hookSpecificOutput.permissionDecisionReason).toBe("Blocked by the team's policy: replaced by release-train (skill.use skill:release-checklist).");
    expect(allowed).toEqual({ code: 0, out: null });
  });

  it("given a merge that removes the rule, when the session calls the server again, then it goes ahead", () => {
    // given
    const m = machine({ policies: one([deny("mcp.use", "mcp:warehouse")]) });
    expect(hook(m, { tool_name: "mcp__warehouse__query" }).out).not.toBeNull();
    writeTeam(m.copy, { policies: [] });

    // when / then
    expect(hook(m, { tool_name: "mcp__warehouse__query" })).toEqual({ code: 0, out: null });
  });

  it("given input that is not a call, when the hook runs, then it allows and exits 0", () => {
    const m = machine({ policies: one([deny("mcp.use", "mcp:warehouse")]) });
    const run = spawnSync(process.execPath, [join(repoRoot, "dist", "pre-tool-use.js")], { input: "not json", env: { PATH: process.env.PATH, HOME: m.userHome }, encoding: "utf8" });
    expect([run.status, run.stdout]).toEqual([0, ""]);
  });
});

describe("a team's rules as Claude Code's own deny entries", () => {
  it("given a rule of each kind, when they are translated, then each becomes Claude Code's entry, path rules are named approximate, and what it cannot say is listed with the reason", () => {
    // when
    const out = claudeDenyRules(
      [
        deny("mcp.use", "mcp:warehouse"),
        deny("mcp.use", "mcp:tracker/deleteIssue"),
        deny("skill.use", "skill:release-checklist"),
        deny("tool.use", "tool:Bash:git push *"),
        deny("tool.use", "tool:WebSearch:*"),
        deny("tool.use", "tool:Edit:*.env"),
        deny("tool.use", "tool:Read:/srv/secrets/*"),
        deny("tool.use", "tool:WebFetch:https://pastebin.example.com/*"),
        deny("tool.use", "tool:WebSearch:salary *"),
      ],
      "acme-skills",
    );

    // then
    expect(out.deny).toEqual([
      "mcp__warehouse",
      "mcp__plugin_*_warehouse__*",
      "mcp__tracker__deleteIssue",
      "mcp__plugin_*_tracker__deleteIssue",
      "Skill(release-checklist)",
      "Skill(acme-skills:release-checklist)",
      "Bash(git push *)",
      "WebSearch",
      "Edit(*.env)",
      "Read(//srv/secrets/**)",
      "WebFetch(domain:pastebin.example.com)",
    ]);
    expect(out.approximate).toEqual([
      { resource: "tool:Edit:*.env", entry: "Edit(*.env)" },
      { resource: "tool:Read:/srv/secrets/*", entry: "Read(//srv/secrets/**)" },
    ]);
    expect(out.notMapped).toEqual([{ resource: "tool:WebSearch:salary *", why: "Claude Code holds WebSearch whole only" }]);
  });
});

describe("matching that holds against long lines, renamed servers and compound commands", () => {
  it("given patterns with many wildcards, when they meet an 18 KB command and a long run of one letter, then each is decided at once", () => {
    const long = Array.from({ length: 3000 }, (_, i) => `word${i}`).join(" ");
    const started = Date.now();
    expect(patternMatches("*git*push*--force*", long)).toBe(false);
    expect(patternMatches("*a*a*a*a*a*a*b", "a".repeat(60))).toBe(false);
    expect(patternMatches("*git*push*--force*", `${long} git push --force`)).toBe(true);
    expect(Date.now() - started).toBeLessThan(200);
  });

  it("given a rule for a server whose name has a dot, when its tools are called by the names Claude Code gives them, then they are blocked and the export names them the same way", () => {
    const rules = [deny("mcp.use", "mcp:tracker.prod")];
    expect(policyDenial(rules, call("mcp__tracker_prod__get"))).toEqual(rules[0]);
    expect(policyDenial(rules, call("mcp__plugin_team-skills_tracker_prod__get"))).toEqual(rules[0]);
    expect(claudeDenyRules(rules).deny).toEqual(["mcp__tracker_prod", "mcp__plugin_*_tracker_prod__*"]);
  });

  it.each([
    ["a brace group", "{ git push; }"],
    ["an if body", "if true; then git push; fi"],
    ["a for body", "for b in main; do git push origin $b; done"],
    ["a command substitution", "echo $(git push)"],
    ["backticks", "echo `git push`"],
    ["the program's full path", "/usr/bin/git push"],
    ["the program in capitals", "GIT push"],
    ["xargs", "echo main | xargs -n 1 git push origin"],
    ["sh -c", "bash -c 'git push origin main'"],
    ["eval", "eval git push"],
  ])("given a rule on pushing, when the push is inside %s, then it is blocked", (_case, command) => {
    const rules = [deny("tool.use", "tool:Bash:git p*")];
    expect(policyDenial(rules, call("Bash", { command }))).toEqual(rules[0]);
  });

  it("given a rule on pushing, when the line only reads the repository, then it goes ahead", () => {
    expect(policyDenial([deny("tool.use", "tool:Bash:git p*")], call("Bash", { command: "if true; then git status; fi; echo $(git log -1)" }))).toBeNull();
  });

  it.each([["a parent step", "/w/x/../secrets/a"], ["a doubled slash", "/w//secrets/a"], ["a dot step", "/w/./secrets/a"]])("given a rule on a directory, when an absolute path reaches it through %s, then it is blocked", (_case, file_path) => {
    const rules = [deny("tool.use", "tool:Edit:/w/secrets/*")];
    expect(policyDenial(rules, call("Write", { file_path }))).toEqual(rules[0]);
  });
});
