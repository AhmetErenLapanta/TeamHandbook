import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import { TOOLS } from "../mcp/tools.js";
import type { RepoRecord } from "../store.js";
import { reviewPrompt } from "./review.js";
import { prompt } from "./runner.js";
import { suggestionPrompt } from "./skills.js";
import { planPrompt } from "./targets.js";

// Measured with the smallest inputs each takes, so only the orchestrator's own wording is counted:
// it is paid on every task and grows a sentence at a time. A raise needs the `context-increase`
// label (.github/workflows/agent-context-budget.yml).
const BUDGET = new URL("./context-budget.json", import.meta.url);
const WORK = { title: "Add an on-call note", description: "" };
const REPO = { name: "payments-skills" } as RepoRecord;

async function measured(): Promise<Record<string, number>> {
  const bytes = (text: string) => Buffer.byteLength(text, "utf8");
  return {
    taskPrompt: bytes(prompt(REPO, WORK.title, WORK.description, null, null, null)),
    taskPromptSkillTemplate: bytes(prompt(REPO, WORK.title, WORK.description, null, null, { kind: "skill.write", skill: "on-call-note" })),
    reviewPrompt: bytes(reviewPrompt(REPO, "", "")),
    planPrompt: bytes(await planPrompt({} as OrchestratorContext, WORK, null, null, [], [])),
    suggestionPrompt: bytes(suggestionPrompt(WORK, null, null, [])),
    mcpToolsList: bytes(JSON.stringify(TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })))),
  };
}

describe("the bytes the orchestrator puts in front of an agent", () => {
  it("given the orchestrator's task, review, planning and suggestion prompts and its MCP tool list, when each is measured, then it is the size context-budget.json records", async () => {
    const now = await measured();
    if (process.env.UPDATE_CONTEXT_BUDGET === "1") writeFileSync(BUDGET, JSON.stringify(now, null, 2) + "\n");
    const recorded: unknown = JSON.parse(readFileSync(BUDGET, "utf8"));
    expect(now, "rerun with UPDATE_CONTEXT_BUDGET=1 to record the new sizes; a pull request that raises one needs the context-increase label").toEqual(recorded);
  });
});
