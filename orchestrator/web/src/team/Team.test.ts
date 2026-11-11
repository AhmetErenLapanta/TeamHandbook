import { describe, expect, it } from "vitest";
import type { Step } from "../setup-steps";
import { openSteps, outcomesCell, teamSentence } from "./Team";

const step = (id: string, patch: Partial<Step> = {}): Step => ({ id, title: id, detail: "", required: true, done: false, to: "/", action: "Go", ...patch });

describe("the sentence at the top of Team", () => {
  it("given people, what is shared and lessons waiting, when the sentence is read, then it says each, leaves out what is not read yet, says when nothing is shared and starts with a capital", () => {
    // when
    const full = teamSentence({ people: 5, shared: { skills: [{ name: "a", repo: "r", tasks: 2 }, { name: "b", repo: "r", tasks: null }], mcpServers: [{ name: "c", repo: "r", tasks: null }] }, lessons: 1 });
    const mine = teamSentence({ people: null, shared: { skills: [], mcpServers: [] }, lessons: 0 });
    const unread = teamSentence({ people: null, shared: null, lessons: null });

    // then
    expect(full).toBe("5 people; 2 skills and 1 MCP server shared; 1 lesson waits for review.");
    expect(mine).toBe("Nothing shared yet.");
    expect(unread).toBe("");
  });
});

describe("the setup still open on Team", () => {
  it("given setup steps done, optional, skipped and required beside a step of using the team, when the open ones are read, then the done and the using go, a required step comes first and a skipped one last", () => {
    // when
    const open = openSteps([step("repo", { done: true }), step("join", { required: false }), step("members"), step("forge"), step("merge")], ["members"]);

    // then
    expect(open.map((s) => s.id)).toEqual(["forge", "join", "members"]);
  });
});

describe("a person's last 30 days on Team", () => {
  const person = { email: "ada@example.invalid", name: "Ada", tasks: 4, merged: 2, closed: 0, kept: 1, undone: 1, failed: 0, usd: 1.5, unknownCost: 0 };

  it("given tasks with a known cost, with some unknown, and none, when the cell is read, then it says what was kept, undone and merged and what it cost", () => {
    // when
    const known = outcomesCell(person);
    const partly = outcomesCell({ ...person, unknownCost: 2 });
    const none = outcomesCell(undefined);
    const nothingYet = outcomesCell({ ...person, kept: 0, undone: 0, merged: 0, usd: 0, unknownCost: 3 });
    const idle = outcomesCell({ ...person, kept: 0, undone: 0, merged: 0, usd: 0, unknownCost: 0, tasks: 2 });

    // then
    expect(known).toBe("1 kept, 1 undone, 2 merged, $1.50");
    expect(partly).toBe("1 kept, 1 undone, 2 merged, $1.50 and 2 tasks with no cost");
    expect(none).toBe("no task");
    expect(nothingYet).toBe("3 tasks with no cost");
    expect(idle).toBe("2 tasks, none kept or merged yet");
  });
});
