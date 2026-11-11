import { describe, expect, it } from "vitest";
import { audienceRefusal, blockRefusal, deleteConsequence, emptyRule, lockedReason, offeredTemplates, MAX_RULES, MIXED, policiesSentence, policySummary, resourceLabel, resourceOf, rulesProblem, savesAsRequest, sharedMessage, TEMPLATES, WHOLE_TEAMS } from "./policy";
import type { PolicyDraft, Rule } from "./policy";

const retire: Rule = { kind: "mcp-access", effect: "deny", resources: ["mcp:legacy-search"], reason: "Replaced by the new search." };
const budget: Rule = { kind: "task-budget", monthlyUsd: 50, per: "member" };

describe("the plain sentence over the policy editor", () => {
  it("given a workspace audience and a server block, when summarised, then the sentence names who and the server without its prefix", () => {
    expect(policySummary({ name: "x", audience: { kind: "workspace" }, rules: [retire] })).toBe("Everyone in the organization cannot use the MCP server legacy-search.");
  });

  it("given a team audience with a tool rule and named ids, when summarised, then tools read with what they are held to and teams read by name", () => {
    const draft: PolicyDraft = { name: "x", audience: { kind: "teams", ids: ["t1", "t2"] }, rules: [{ kind: "tool-access", effect: "deny", resources: ["tool:Bash:rm *", "tool:Edit:*"], reason: "r" }] };
    expect(policySummary(draft, (id) => ({ t1: "Payments", t2: "Mobile" })[id] ?? id)).toBe("Members of Payments and Mobile cannot use Bash (rm *) and Edit in Claude Code.");
  });

  it("given a per-member budget, when summarised, then the sentence says each member and the amount", () => {
    expect(policySummary({ name: "x", audience: { kind: "workspace" }, rules: [budget] })).toBe("Everyone in the organization can each spend up to $50 a month on tasks.");
  });

  it("given no rules, when summarised, then the sentence asks for one", () => {
    expect(policySummary({ name: "x", audience: { kind: "tags", ids: [] }, rules: [] })).toBe("Members with the chosen tags: add a rule to say what this policy does.");
  });
});

describe("why saving is locked", () => {
  it("given a budget block without an amount, when checked, then the reason asks for the monthly limit", () => {
    expect(lockedReason({ name: "Budget", audience: { kind: "workspace" }, rules: [emptyRule("task-budget")] })).toBe("Enter a monthly limit to continue.");
  });

  it("given a zero budget, when checked, then it is refused as the server refuses it", () => {
    expect(rulesProblem({ audience: { kind: "workspace" }, rules: [{ ...budget, monthlyUsd: 0 }] })).toMatch(/above \$0/);
  });

  it("given a blocking rule without a reason, when checked, then the reason is asked for", () => {
    expect(rulesProblem({ audience: { kind: "workspace" }, rules: [{ ...retire, reason: " " }] })).toMatch(/^Say why/);
  });

  it("given a blocking rule and an orchestrator rule together, when checked, then the policy is refused as mixed", () => {
    expect(rulesProblem({ audience: { kind: "workspace" }, rules: [retire, budget] })).toBe(MIXED);
  });

  it("given a blocking rule aimed at chosen members, when checked, then it is refused because it applies to whole teams", () => {
    expect(rulesProblem({ audience: { kind: "members", ids: ["u1"] }, rules: [retire] })).toBe(WHOLE_TEAMS);
  });

  it("given more than the most rules, when checked, then it says to split", () => {
    expect(rulesProblem({ audience: { kind: "workspace" }, rules: Array.from({ length: MAX_RULES + 1 }, () => budget) })).toMatch(/at most 20 rules/);
  });

  it("given a complete policy without a name, when checked, then only the name is missing and the preview is ready", () => {
    const draft: PolicyDraft = { name: " ", audience: { kind: "teams", ids: ["t1"] }, rules: [retire] };
    expect(lockedReason(draft)).toBe("Name the policy to continue.");
    expect(rulesProblem(draft)).toBeNull();
  });
});

describe("which blocks and audiences fit", () => {
  const admin = { isAdmin: true, orchestratorRulesStored: true };

  it("given a policy with a blocking rule, when an orchestrator block is offered, then it is refused with the reason", () => {
    expect(blockRefusal("task-budget", { ...admin, rules: [retire] })).toMatch(/policy of their own/);
    expect(blockRefusal("skill-access", { ...admin, rules: [retire] })).toBeNull();
  });

  it("given a member who is not an admin, when an orchestrator block is offered, then only an admin may add it", () => {
    expect(blockRefusal("repo-access", { isAdmin: false, orchestratorRulesStored: true, rules: [] })).toBe("Only an admin sets the orchestrator's own rules.");
  });

  it("given an orchestrator that does not store its own rules, when an orchestrator block is offered, then it is refused before saving", () => {
    expect(blockRefusal("task-budget", { isAdmin: true, orchestratorRulesStored: false, rules: [] })).toMatch(/does not keep its own rules/);
  });

  it("given a blocking rule, when a member audience is chosen, then it is refused and teams stay open", () => {
    expect(audienceRefusal("except-members", [retire])).toBe(WHOLE_TEAMS);
    expect(audienceRefusal("teams", [retire])).toBeNull();
    expect(audienceRefusal("members", [budget])).toBeNull();
  });

  it("given orchestrator rules only, when the save note is read, then it applies now instead of opening a request", () => {
    expect(savesAsRequest({ rules: [budget] })).toBe(false);
    expect(savesAsRequest({ rules: [retire] })).toBe(true);
  });
});

describe("resources and templates", () => {
  it("given what a person typed, when made a resource and read back, then the prefix is added and hidden again", () => {
    expect(resourceOf("mcp-access", " search/query ")).toBe("mcp:search/query");
    expect(resourceLabel("mcp:search/query")).toBe("query on search");
    expect(resourceLabel("skill:deploy")).toBe("deploy");
  });

  it("given the four templates, when each is opened, then its rules use only tools the team file accepts and it locks on what is left to fill in", () => {
    expect(TEMPLATES.map((t) => t.name)).toEqual(["Retire an MCP server", "Read-only Bash for a team", "Monthly task budget per team", "Keep a skill to one team"]);
    const reasons = TEMPLATES.map((t) => lockedReason(t.draft({ teams: ["payments", "mobile"], everyone: true })));
    expect(reasons).toEqual(["Name the MCP servers this rule blocks to continue.", "Choose teams to continue.", "Choose teams to continue.", "Name the skills this rule blocks to continue."]);
  });

  it("given the team list, when the keep-to-one-team template opens, then every team is in the audience to take one off", () => {
    expect(TEMPLATES[3]!.draft({ teams: ["payments", "mobile"], everyone: true }).audience).toEqual({ kind: "teams", ids: ["payments", "mobile"] });
  });

  it("given an owner or admin, a team's owner and a member who owns no team, when the templates are offered, then the first gets all four, the second the three that reach teammates, the third none", () => {
    expect(offeredTemplates(true, false).map((t) => t.id)).toEqual(["retire-mcp", "read-only-bash", "team-task-budget", "skill-one-team"]);
    expect(offeredTemplates(false, true).map((t) => t.id)).toEqual(["retire-mcp", "read-only-bash", "skill-one-team"]);
    expect(offeredTemplates(false, false)).toEqual([]);
  });

  it("given a team's owner, when a template that reaches everyone opens, then it starts with their own teams instead and saves once a server is named", () => {
    const draft = TEMPLATES[0]!.draft({ teams: ["payments"], everyone: false });
    expect(draft.audience).toEqual({ kind: "teams", ids: ["payments"] });
    expect(lockedReason({ ...draft, rules: [{ kind: "mcp-access", effect: "deny", resources: ["mcp:legacy"], reason: "Retired." }] })).toBeNull();
  });
});

describe("the message proposed for every repository a save touches", () => {
  it("given proposals under different commit prefixes, when shared, then no repository's prefix is in it", () => {
    expect(sharedMessage(["PAY chore(policy): retire postgres", "chore(policy): retire postgres", "OPS chore(policy): retire postgres"])).toBe("chore(policy): retire postgres");
  });

  it("given one repository, when shared, then its own proposal stands", () => {
    expect(sharedMessage(["PAY chore(policy): retire postgres"])).toBe("PAY chore(policy): retire postgres");
  });
});

describe("what deleting an orchestrator policy says first", () => {
  it("given a policy with a budget and repository rules, when its deletion is asked, then it names both limits that stop at once", () => {
    expect(deleteConsequence({ rules: [budget, { kind: "repo-access", effect: "deny", repos: ["payments-skills"] }, { kind: "repo-access", effect: "allow", repos: ["*"] }] })).toBe(
      "Deleting it applies at once: tasks stop counting against its $50 monthly budget and its rules on where tasks start stop holding. The deletion is recorded in the audit log.",
    );
  });

  it("given a budget only, when its deletion is asked, then only the budget is named", () => {
    expect(deleteConsequence({ rules: [budget] })).toBe("Deleting it applies at once: tasks stop counting against its $50 monthly budget. The deletion is recorded in the audit log.");
  });
});

describe("a permission ceiling in a policy", () => {
  it("given a new ceiling block, when it is added and read, then it starts at Auto on every repository and the sentence says so", () => {
    // when
    const rule = emptyRule("task-mode");

    // then
    expect(rule).toEqual({ kind: "task-mode", ceiling: "auto", repos: ["*"] });
    expect(policySummary({ name: "x", audience: { kind: "teams", ids: ["Payments"] }, rules: [{ kind: "task-mode", ceiling: "auto-accept-edits", repos: ["payments-skills"] }] })).toBe("Members of Payments can run tasks on payments-skills in Auto-accept edits mode at most.");
    expect(policySummary({ name: "x", audience: { kind: "workspace" }, rules: [rule] })).toBe("Everyone in the organization can run tasks on every repository in Auto mode at most.");
  });

  it("given a ceiling on no repository, when saving is checked, then it waits for a repository, and deleting a saved one says the ceiling stops holding", () => {
    // when
    const locked = rulesProblem({ audience: { kind: "workspace" }, rules: [{ kind: "task-mode", ceiling: "auto", repos: [] }] });
    const consequence = deleteConsequence({ rules: [{ kind: "task-mode", ceiling: "auto", repos: ["*"] }] });

    // then
    expect(locked).toBe("Choose repositories to continue.");
    expect(consequence).toBe("Deleting it applies at once: its ceiling on how much agents do without asking stops holding. The deletion is recorded in the audit log.");
  });
});

describe("the starter's own setup in a policy", () => {
  it("given a new block for the starter's own setup, when it is added and read, then it turns the setup off on every repository and the sentence and the deletion say so", () => {
    // when
    const rule = emptyRule("own-setup");
    const consequence = deleteConsequence({ rules: [rule] });

    // then
    expect(rule).toEqual({ kind: "own-setup", allowed: false, repos: ["*"] });
    expect(policySummary({ name: "x", audience: { kind: "teams", ids: ["Payments"] }, rules: [rule] })).toBe("Members of Payments can run tasks on every repository only with their sign-in and the team's skills.");
    expect(consequence).toBe("Deleting it applies at once: tasks use their starter's own Claude Code setup again. The deletion is recorded in the audit log.");
    expect(rulesProblem({ audience: { kind: "workspace" }, rules: [{ kind: "own-setup", allowed: false, repos: [] }] })).toBe("Choose repositories to continue.");
  });
});

describe("the sentence in Team's policies", () => {
  it("given policies not read yet, none, one and several, when the sentence is read, then it says how many hold", () => {
    // when
    const said = [null, 0, 1, 3].map(policiesSentence);

    // then
    expect(said).toEqual(["A policy holds a group to rules.", "No policy holds anyone to a rule yet.", "1 policy holds groups to rules.", "3 policies hold groups to rules."]);
  });
});
