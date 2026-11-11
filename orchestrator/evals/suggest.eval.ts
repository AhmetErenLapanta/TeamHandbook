import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeCodeAdapter } from "../server/tasks/agents.js";
import { askForSkills, readSuggestions, suggestionPrompt } from "../server/tasks/skills.js";
import { Redactor } from "../server/tasks/redact.js";
import type { PlanSkill } from "../server/tasks/targets.js";

// The skill-suggestion prompt against a real model, through the orchestrator's own path: the prompt
// the orchestrator builds, the Claude Code CLI it starts, the parser it reads the answer with.
// See evals/README.md. Without EVAL_LIVE=1 nothing is called and only the cases are checked.

interface Case {
  id: string;
  kind: "control" | "guard" | "bad";
  work: { title: string; description: string };
  skills: { name: string; description: string }[];
  expect: { must: string[]; mustNot: string[] };
}

interface CaseResult {
  id: string;
  kind: Case["kind"];
  passed: number;
  samples: number;
  answers: string[][];
  usd: number | null;
}

const LIVE = process.env.EVAL_LIVE === "1";
const SAMPLES = Number(process.env.EVAL_SAMPLES ?? 3);
const ONLY = process.env.EVAL_CASE;
const CASES = (JSON.parse(readFileSync(new URL("./suggest.cases.json", import.meta.url), "utf8")) as Case[]).filter((c) => !ONLY || c.id === ONLY);

const planSkills = (c: Case): PlanSkill[] => c.skills.map((s) => ({ ...s, repositories: null, from: "payments-skills" }));
const graded = (c: Case, named: string[]) => c.expect.must.every((s) => named.includes(s)) && c.expect.mustNot.every((s) => !named.includes(s));

describe("the skill-suggestion prompt's cases", () => {
  it("given the cases, when each is read, then its prompt builds and an answer naming exactly what it expects passes its own grade", () => {
    expect(CASES.length).toBeGreaterThan(0);
    for (const c of CASES) {
      const prompt = suggestionPrompt(c.work, null, null, planSkills(c));
      expect(prompt).toContain(c.work.title);
      const ideal = readSuggestions(c.expect.must.map((s) => `SKILL: ${s}: it fits`).join("\n"), c.skills.map((s) => s.name), new Redactor());
      expect(graded(c, ideal.map((s) => s.skill)), c.id).toBe(true);
    }
  });
});

describe.skipIf(!LIVE)("the skill-suggestion prompt against a real model", () => {
  it("given each case, when the model is asked as the orchestrator asks it, then the result is written for comparison", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "orchestrator-eval-"));
    const agent = claudeCodeAdapter(process.env.ORCHESTRATOR_CLAUDE_BIN || "claude");
    const deps = { agent, isolation: { mode: "process" as const, network: "open" as const }, hostEnv: process.env, passEnv: [], timeoutMs: 180_000, dataDir, tenant: "eval", model: null };
    const results: CaseResult[] = [];
    try {
      for (const c of CASES) {
        const result: CaseResult = { id: c.id, kind: c.kind, passed: 0, samples: SAMPLES, answers: [], usd: null };
        for (let i = 0; i < SAMPLES; i++) {
          const prompt = suggestionPrompt(c.work, null, null, planSkills(c));
          const { suggestions, cost } = await askForSkills(prompt, c.skills.map((s) => s.name), deps, `${c.id}-${i}`.slice(-40));
          const named = suggestions?.map((s) => s.skill) ?? [];
          result.answers.push(suggestions ? named : ["(no answer)"]);
          if (suggestions && graded(c, named)) result.passed++;
          if (cost.usd !== null) result.usd = (result.usd ?? 0) + cost.usd;
        }
        results.push(result);
      }
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }

    const out = process.env.EVAL_OUT ?? join(tmpdir(), `orchestrator-eval-suggest-${Date.now()}.json`);
    writeFileSync(out, JSON.stringify({ suite: "suggest", samples: SAMPLES, results }, null, 2) + "\n");
    const baseline = process.env.EVAL_BASELINE ? (JSON.parse(readFileSync(process.env.EVAL_BASELINE, "utf8")) as { results: CaseResult[] }).results : [];
    for (const r of results) {
      const before = baseline.find((b) => b.id === r.id);
      const was = before ? ` (baseline ${before.passed}/${before.samples})` : "";
      console.log(`${r.kind.padEnd(7)} ${r.id}: ${r.passed}/${r.samples}${was}${r.usd === null ? "" : `, $${r.usd.toFixed(4)}`}`);
    }
    console.log(`written to ${out}`);
  });
});
