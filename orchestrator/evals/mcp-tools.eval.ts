import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../server/mcp/tools.js";

// The orchestrator's MCP tools as a real model meets them: their own names, descriptions and input
// schemas, served by a stand-in server that runs nothing, answers each case's calls from the case and
// keeps every call. A case says which tools the ask has to reach, in order, and which it must not.
// See evals/README.md. Without EVAL_LIVE=1 nothing is called and only the cases are checked.

interface Case {
  id: string;
  kind: "control" | "guard" | "bad";
  ask: string;
  answers: Record<string, unknown>;
  expect: { calls: string[]; mustNot: string[] };
}

interface CaseResult {
  id: string;
  kind: Case["kind"];
  passed: number;
  samples: number;
  called: string[][];
  usd: number | null;
}

const LIVE = process.env.EVAL_LIVE === "1";
const SAMPLES = Number(process.env.EVAL_SAMPLES ?? 3);
const ONLY = process.env.EVAL_CASE;
const CASES = (JSON.parse(readFileSync(new URL("./mcp-tools.cases.json", import.meta.url), "utf8")) as Case[]).filter((c) => !ONLY || c.id === ONLY);
const SERVER = "orchestrator";

/** The calls a case expects, in its order, among what was called, and none of the ones it must not. */
const graded = (c: Case, called: string[]) => {
  let at = 0;
  for (const name of called) if (name === c.expect.calls[at]) at++;
  return at === c.expect.calls.length && c.expect.mustNot.every((name) => !called.includes(name));
};

/** An MCP server over HTTP with the orchestrator's tool list, answering from the case and keeping each call's name. */
async function standIn(c: Case): Promise<{ url: string; called: string[]; close: () => Promise<void> }> {
  const called: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const msg = JSON.parse(raw || "{}") as { id?: number; method?: string; params?: { name?: string } };
      const reply = (result: unknown) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      if (msg.id === undefined) return void res.writeHead(202).end();
      if (msg.method === "initialize") return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: SERVER, version: "eval" } });
      if (msg.method === "tools/list") return reply({ tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      if (msg.method === "tools/call") {
        const name = msg.params?.name ?? "?";
        called.push(name);
        return reply({ content: [{ type: "text", text: JSON.stringify(c.answers[name] ?? { ok: true }) }] });
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "unknown method" } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/mcp`, called, close: () => new Promise((resolve) => server.close(() => resolve())) };
}

/** One sample: the CLI with only the stand-in server, its code-running and web tools taken away; the cost from its result line. */
async function ask(c: Case, dir: string, url: string): Promise<number | null> {
  const config = join(dir, "mcp.json");
  writeFileSync(config, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url } } }));
  const args = ["-p", c.ask, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--strict-mcp-config", "--mcp-config", config,
    "--allowedTools", TOOLS.map((t) => `mcp__${SERVER}__${t.name}`).join(","), "--disallowedTools", "Bash,Edit,Write,NotebookEdit,WebFetch,WebSearch"];
  const child = spawn(process.env.ORCHESTRATOR_CLAUDE_BIN || "claude", args, { cwd: dir, stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", (chunk) => (out += chunk));
  await new Promise((resolve) => child.on("close", resolve));
  const result = out.split("\n").map((l) => { try { return JSON.parse(l) as { type?: string; total_cost_usd?: number }; } catch { return null; } }).find((f) => f?.type === "result");
  return typeof result?.total_cost_usd === "number" ? result.total_cost_usd : null;
}

describe("the MCP tools' cases", () => {
  it("given the cases, when each is read, then it names only the orchestrator's tools, the calls it expects pass its grade and a forbidden call fails it", () => {
    const names = TOOLS.map((t) => t.name);
    expect(CASES.length).toBeGreaterThan(0);
    for (const c of CASES) {
      for (const name of [...c.expect.calls, ...c.expect.mustNot, ...Object.keys(c.answers)]) expect(names, `${c.id}: ${name}`).toContain(name);
      expect(graded(c, c.expect.calls), c.id).toBe(true);
      if (c.expect.mustNot.length) expect(graded(c, [...c.expect.calls, c.expect.mustNot[0]!]), c.id).toBe(false);
      if (c.expect.calls.length > 1) expect(graded(c, [...c.expect.calls].reverse()), c.id).toBe(false);
    }
  });
});

describe.skipIf(!LIVE)("the MCP tools against a real model", () => {
  it("given each case, when the model is asked with the orchestrator's tools, then the result is written for comparison", async () => {
    const results: CaseResult[] = [];
    for (const c of CASES) {
      const result: CaseResult = { id: c.id, kind: c.kind, passed: 0, samples: SAMPLES, called: [], usd: null };
      for (let i = 0; i < SAMPLES; i++) {
        const dir = mkdtempSync(join(tmpdir(), "orchestrator-eval-mcp-"));
        const server = await standIn(c);
        try {
          const usd = await ask(c, dir, server.url);
          result.called.push([...server.called]);
          if (graded(c, server.called)) result.passed++;
          if (usd !== null) result.usd = (result.usd ?? 0) + usd;
        } finally {
          await server.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }
      results.push(result);
    }

    const out = process.env.EVAL_OUT ?? join(tmpdir(), `orchestrator-eval-mcp-tools-${Date.now()}.json`);
    writeFileSync(out, JSON.stringify({ suite: "mcp-tools", samples: SAMPLES, results }, null, 2) + "\n");
    const baseline = process.env.EVAL_BASELINE ? (JSON.parse(readFileSync(process.env.EVAL_BASELINE, "utf8")) as { results: CaseResult[] }).results : [];
    for (const r of results) {
      const before = baseline.find((b) => b.id === r.id);
      const was = before ? ` (baseline ${before.passed}/${before.samples})` : "";
      console.log(`${r.kind.padEnd(7)} ${r.id}: ${r.passed}/${r.samples}${was}${r.usd === null ? "" : `, $${r.usd.toFixed(4)}`}`);
    }
    console.log(`written to ${out}`);
  });
});
