import { describe, expect, it } from "vitest";
import { git } from "../git.js";
import { screenedBranch, taskBranch, taskSubject } from "./naming.js";

const ID = "tsk_01jc5x7q4m0000000000012345";

describe("the branch a task's request goes on", () => {
  it("given no team rule, when the branch is named, then it is task/<id>", () => {
    expect(taskBranch(ID, "Add a note", null)).toEqual({ branch: `task/${ID}` });
    expect(taskBranch(ID, "Add a note", { commitPrefix: "PAY" })).toEqual({ branch: `task/${ID}` });
  });

  it("given a ticket key in the team's commit prefix, when the branch is named, then it starts with that key", () => {
    expect(taskBranch(ID, "Add a note", { commitPrefix: "OPS-7" })).toEqual({ branch: "OPS-7-add-a-note-012345" });
  });

  it("given the team's example branch, when the branch is named, then it takes the example's prefix", () => {
    expect(taskBranch(ID, "Add a note", { branchExample: "feature/rotate-certs" })).toEqual({ branch: "feature/add-a-note-012345" });
    expect(taskBranch(ID, "Add a note", { branchExample: "team/payments/fix-ledger" })).toEqual({ branch: "team/payments/add-a-note-012345" });
  });

  it("given an example that leads with a ticket and no issue, when the branch is named, then there is no name: the task asks for a ticket", () => {
    expect(taskBranch(ID, "Add a note", { branchExample: "PAY-12-fix-ledger" })).toEqual({ needsTicket: "PAY-12-fix-ledger" });
    expect(taskBranch(ID, "Add a note", { branchExample: "PAY-12-fix-ledger", commitPrefix: "PAY" })).toEqual({ needsTicket: "PAY-12-fix-ledger" });
  });

  it("given an example that leads with a ticket and an issue or a ticket prefix, when the branch is named, then that ticket fills it", () => {
    expect(taskBranch(ID, "Add a note", { branchExample: "PAY-12-fix-ledger" }, { key: "PAY-142", branchToken: "PAY-142" })).toEqual({ branch: "PAY-142-add-a-note-012345" });
    expect(taskBranch(ID, "Add a note", { branchExample: "PAY-12-fix-ledger", commitPrefix: "OPS-7" })).toEqual({ branch: "OPS-7-add-a-note-012345" });
  });

  it("given an example that has no prefix or is not a branch name, when the branch is named, then the default holds", () => {
    for (const branchExample of ["fix-ledger", "feature/../x", "bad name/x", `feature/${"x".repeat(120)}`]) {
      expect(taskBranch(ID, "Add a note", { branchExample }), branchExample).toEqual({ branch: `task/${ID}` });
    }
  });
});

describe("the title a task's request carries", () => {
  it("given the team's commit prefix, when the subject is written, then the prefix leads it once", () => {
    expect(taskSubject("Add a note", { commitPrefix: "PAY" })).toBe("PAY Add a note");
    expect(taskSubject("PAY Add a note", { commitPrefix: "PAY" })).toBe("PAY Add a note");
    expect(taskSubject("Add a note", { commitPrefix: "" })).toBe("Add a note");
    expect(taskSubject("Add a note", null)).toBe("Add a note");
  });
});

describe("names for a task that works on an issue", () => {
  const jira = { key: "PAY-142", branchToken: "PAY-142" };

  it("given an issue, when the branch is named, then the issue's key leads it, under the team's example prefix when there is one", () => {
    expect(taskBranch(ID, "Fix rounding", null, jira)).toEqual({ branch: "PAY-142-fix-rounding-012345" });
    expect(taskBranch(ID, "Work on PAY-142", null, jira)).toEqual({ branch: "PAY-142-work-on-012345" });
    expect(taskBranch(ID, "Fix rounding", { branchExample: "feature/rotate-certs" }, jira)).toEqual({ branch: "feature/PAY-142-fix-rounding-012345" });
    expect(taskBranch(ID, "Fix rounding", { branchExample: "PAY-12-fix-ledger", commitPrefix: "OPS-7" }, jira)).toEqual({ branch: "PAY-142-fix-rounding-012345" });
    expect(taskBranch(ID, "Fix rounding", null, { key: "acme/payments#12", branchToken: "payments-12" })).toEqual({ branch: "payments-12-fix-rounding-012345" });
  });

  it("given an issue, when the subject is written, then it carries the key once, after a prefix the key does not start with or in place of a ticket prefix", () => {
    expect(taskSubject("Fix rounding", null, "PAY-142")).toBe("PAY-142 Fix rounding");
    expect(taskSubject("Work on PAY-142", null, "PAY-142")).toBe("Work on PAY-142");
    expect(taskSubject("Fix rounding", { commitPrefix: "OPS" }, "PAY-142")).toBe("OPS PAY-142 Fix rounding");
    expect(taskSubject("Fix rounding", { commitPrefix: "OPS-7" }, "PAY-142")).toBe("PAY-142 Fix rounding");
  });

  it("given a team prefix that the issue's key starts with, when the subject is written, then the key carries the prefix and it is not written twice", () => {
    // given
    const team = { commitPrefix: "PAY", branchExample: "PAY-12-fix-ledger" };

    // when
    const subject = taskSubject("Fix rounding", team, "PAY-990");

    // then
    expect(subject).toBe("PAY-990 Fix rounding");
    expect(taskSubject("Fix rounding", { commitPrefix: "pay" }, "PAY-990")).toBe("PAY-990 Fix rounding");
    expect(taskSubject("Fix rounding", team)).toBe("PAY Fix rounding");
    expect(taskSubject("Work on PAY-990", team, "PAY-990")).toBe("PAY Work on PAY-990");
  });
});

describe("branch names git refuses", () => {
  it("given an example whose prefix git refuses or that reads as another ref, when the branch is named, then the default holds", () => {
    for (const branchExample of ["feat.lock/x", "a/.hidden/x", "refs/heads/x", "HEAD/x"]) {
      expect(taskBranch(ID, "Add a note", { branchExample }), branchExample).toEqual({ branch: `task/${ID}` });
    }
  });

  it("given every name the rules produce, when git checks it, then git accepts it", () => {
    const names = [
      taskBranch(ID, "Add a note", null),
      taskBranch(ID, "Add a note", { commitPrefix: "OPS-7" }),
      taskBranch(ID, "Add a note", { branchExample: "team/payments/fix-ledger" }),
      taskBranch(ID, "-rf --force ../../etc", { branchExample: "feature/x" }, { key: "PAY-142", branchToken: "PAY-142" }),
    ].map((named) => (named as { branch: string }).branch);
    for (const name of names) expect(() => git(["check-ref-format", "--branch", name], process.cwd()), name).not.toThrow();
  });

  it("given a name git refuses, or one that carries a credential, when it is screened before the agent runs, then the task falls back to task/<id> and says why without the name", async () => {
    const token = `ghp_${"A1b2C3d4".repeat(5).slice(0, 36)}`;
    expect(await screenedBranch("feat.lock/add-a-note-012345", ID)).toEqual({ branch: `task/${ID}`, problem: "git does not accept that as a branch name" });
    const withToken = await screenedBranch(`feature/${token}-012345`, ID);
    expect(withToken.branch).toBe(`task/${ID}`);
    expect(withToken.problem).toMatch(/^that branch name cannot be used: /);
    expect(withToken.problem).not.toContain(token);
    expect(await screenedBranch("feature/add-a-note-012345", ID)).toEqual({ branch: "feature/add-a-note-012345", problem: null });
  });
});
