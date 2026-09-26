import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadHarvestConfig } from "./harvest.js";
import { runDoctor, runCommand } from "./doctor.js";
import {
  buildScorePrompt,
  childEnv,
  childIsolationArgsFor,
  helpFormatRecognized,
  claudeErrorReason,
  defaultScoreConfig,
  loadScoreConfig,
  gateAutoEnabled,
  parseScoreResponse,
  runClaudeCli,
  scoreSignal,
} from "./score.js";
import type { Signal } from "./signals.js";

function candidate(overrides: Partial<Signal> = {}): Signal {
  return {
    ts: "2026-08-08T00:00:00Z",
    sessionId: "s1",
    kind: "candidate",
    fingerprint: "abc123",
    family: "npm test",
    command: "npm test",
    error: "1 test failed",
    cwd: "/repo",
    count: 3,
    edits: ["/repo/app.ts"],
    resolvedCommand: "npm test",
    resolvedAt: "2026-08-08T00:10:00Z",
    ...overrides,
  };
}

const fullMarks =
  '{"scores": {"recurrence": 2, "unfindability": 2, "generality": 2, "durability": 2, "costOfError": 2}, "rationale": "recurring gotcha"}';

describe("buildScorePrompt", () => {
  it("includes the candidate facts and the ledger occurrence count", () => {
    const prompt = buildScorePrompt(candidate(), 4);
    expect(prompt).toContain("failed command:\n  npm test");
    expect(prompt).toContain("error (normalized):\n  1 test failed");
    expect(prompt).toContain("files edited for the fix:\n  /repo/app.ts");
    expect(prompt).toContain("seen in the local ledger: 4");
    expect(prompt).toContain("occurrences within the session: 3");
  });

  it("marks missing resolution and edits explicitly", () => {
    const prompt = buildScorePrompt(candidate({ resolvedCommand: undefined, edits: [] }), 1);
    expect(prompt).toContain("resolving command:\n  (none recorded)");
    expect(prompt).toContain("files edited for the fix:\n  (none)");
  });

  it("demands a JSON-only reply covering all five criteria", () => {
    const prompt = buildScorePrompt(candidate(), 1);
    expect(prompt).toContain("ONLY a JSON object");
    for (const criterion of ["recurrence", "unfindability", "generality", "durability", "costOfError"]) {
      expect(prompt).toContain(`"${criterion}"`);
    }
  });

  it("omits the dedup section when no existing skills are given", () => {
    expect(buildScorePrompt(candidate(), 1)).not.toContain("Existing skills");
  });

  it("lists existing skills and asks for duplicateOf", () => {
    const prompt = buildScorePrompt(candidate(), 1, [
      { name: "fix-npm-cache", description: "Use when npm install fails on a stale cache." },
    ]);
    expect(prompt).toContain("Existing skills already available to the team");
    expect(prompt).toContain("fix-npm-cache:\n  Use when npm install fails on a stale cache.");
    expect(prompt).toContain('"duplicateOf"');
  });

  // A manual-model capture (the model invoked /handbook:learn on its
  // own) has no ledger history either - it is scored on this same call, the same
  // as a user-typed manual capture - so it must get the same no-ledger-history
  // recurrence guidance, not be silently judged by the raw occurrence count.
  it("gives manual-model the same no-ledger-history recurrence guidance as manual", () => {
    const manualPrompt = buildScorePrompt(candidate({ trigger: "manual" }), 1);
    const manualModelPrompt = buildScorePrompt(candidate({ trigger: "manual-model" }), 1);
    expect(manualPrompt).toContain("no ledger history");
    expect(manualModelPrompt).toContain("no ledger history");
    // same trigger framing text for both, so scoring is not skewed by which one
    // asked
    const extractTriggerLine = (p: string) => p.split("\n").find((l) => l.startsWith("- trigger:"));
    expect(extractTriggerLine(manualModelPrompt)).toBe(extractTriggerLine(manualPrompt));
  });

  it("omits the no-ledger-history guidance for an automatic harvest signal", () => {
    const prompt = buildScorePrompt(candidate({ trigger: undefined }), 4);
    expect(prompt).not.toContain("no ledger history");
    expect(prompt).not.toMatch(/^- trigger:/m);
  });
});

describe("parseScoreResponse", () => {
  it("sums the five criteria and passes at the threshold", () => {
    const result = parseScoreResponse(fullMarks, 7);
    expect(result).toMatchObject({ total: 10, pass: true, rationale: "recurring gotcha" });
  });

  it("fails below the threshold", () => {
    const result = parseScoreResponse(
      '{"scores": {"recurrence": 2, "unfindability": 1, "generality": 1, "durability": 1, "costOfError": 1}}',
      7,
    );
    expect(result).toMatchObject({ total: 6, pass: false });
    expect(result?.rationale).toBeUndefined();
  });

  it("extracts JSON wrapped in a code fence or prose", () => {
    const result = parseScoreResponse("Here is my verdict:\n```json\n" + fullMarks + "\n```", 7);
    expect(result?.total).toBe(10);
  });

  it("fails a duplicate even when the score clears the threshold", () => {
    const result = parseScoreResponse(
      fullMarks.replace('"rationale"', '"duplicateOf": "fix-npm-cache", "rationale"'),
      7,
    );
    expect(result).toMatchObject({ total: 10, pass: false, duplicateOf: "fix-npm-cache" });
  });

  it("ignores a null or empty duplicateOf", () => {
    const withNull = parseScoreResponse(
      fullMarks.replace('"rationale"', '"duplicateOf": null, "rationale"'),
      7,
    );
    expect(withNull).toMatchObject({ pass: true });
    expect(withNull?.duplicateOf).toBeUndefined();
    const withEmpty = parseScoreResponse(
      fullMarks.replace('"rationale"', '"duplicateOf": "  ", "rationale"'),
      7,
    );
    expect(withEmpty).toMatchObject({ pass: true });
    expect(withEmpty?.duplicateOf).toBeUndefined();
  });

  it.each([
    ["no JSON at all", "I would score this highly."],
    ["invalid JSON", "{scores: broken}"],
    ["missing criterion", '{"scores": {"recurrence": 2}}'],
    ["out-of-range score", fullMarks.replace('"recurrence": 2', '"recurrence": 3')],
    ["negative score", fullMarks.replace('"recurrence": 2', '"recurrence": -1')],
    ["non-integer score", fullMarks.replace('"recurrence": 2', '"recurrence": 1.5')],
    ["non-numeric score", fullMarks.replace('"recurrence": 2', '"recurrence": "high"')],
  ])("returns null on %s", (_label, text) => {
    expect(parseScoreResponse(text, 7)).toBeNull();
  });
});

describe("scoreSignal", () => {
  it("promotes when the runner returns a passing score", async () => {
    const verdict = await scoreSignal(candidate(), 4, defaultScoreConfig, async () => fullMarks);
    expect(verdict.outcome).toBe("promote");
    expect(verdict.result?.total).toBe(10);
  });

  it("rejects when the score is below the threshold", async () => {
    const verdict = await scoreSignal(
      candidate(),
      4,
      defaultScoreConfig,
      async () =>
        '{"scores": {"recurrence": 0, "unfindability": 0, "generality": 0, "durability": 0, "costOfError": 0}}',
    );
    expect(verdict.outcome).toBe("reject");
    expect(verdict.result?.total).toBe(0);
  });

  it("passes the prompt, configured model, and timeout to the runner", async () => {
    const calls: Array<{ prompt: string; model: string; timeoutMs: number }> = [];
    await scoreSignal(candidate(), 2, { model: "opus", threshold: 7, timeoutMs: 1234 }, async (prompt, model, timeoutMs) => {
      calls.push({ prompt, model, timeoutMs });
      return fullMarks;
    });
    expect(calls).toEqual([
      { prompt: expect.stringContaining("npm test"), model: "opus", timeoutMs: 1234 },
    ]);
  });

  it("returns an error verdict when the runner throws", async () => {
    const verdict = await scoreSignal(candidate(), 4, defaultScoreConfig, async () => {
      throw new Error("claude not found");
    });
    expect(verdict.outcome).toBe("error");
    expect(verdict.error).toContain("claude not found");
  });

  it("returns an error verdict on an unparseable response", async () => {
    const verdict = await scoreSignal(candidate(), 4, defaultScoreConfig, async () => "no json here");
    expect(verdict).toMatchObject({ outcome: "error", error: "unparseable score response" });
  });

  it("includes existing skills in the prompt and rejects a declared duplicate", async () => {
    const prompts: string[] = [];
    const verdict = await scoreSignal(
      candidate(),
      4,
      defaultScoreConfig,
      async (prompt) => {
        prompts.push(prompt);
        return fullMarks.replace('"rationale"', '"duplicateOf": "fix-npm-cache", "rationale"');
      },
      [{ name: "fix-npm-cache", description: "Use when npm install fails on a stale cache." }],
    );
    expect(prompts[0]).toContain("fix-npm-cache:");
    expect(verdict.outcome).toBe("reject");
    expect(verdict.result?.duplicateOf).toBe("fix-npm-cache");
  });
});

describe("loadScoreConfig", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("returns defaults when no config file exists", () => {
    expect(loadScoreConfig(home)).toEqual(defaultScoreConfig);
  });

  it("applies gate overrides from config.json", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ gate: { model: "sonnet", threshold: 8, timeoutMs: 5000 } }),
    );
    expect(loadScoreConfig(home)).toEqual({ model: "sonnet", threshold: 8, timeoutMs: 5000 });
  });

  it("falls back per field on invalid values", () => {
    writeFileSync(
      join(home, "config.json"),
      JSON.stringify({ gate: { model: 42, threshold: 99, timeoutMs: -1 } }),
    );
    expect(loadScoreConfig(home)).toEqual(defaultScoreConfig);
  });

  it("returns defaults on a corrupt config file", () => {
    writeFileSync(join(home, "config.json"), "not json");
    expect(loadScoreConfig(home)).toEqual(defaultScoreConfig);
  });
});

describe("gateAutoEnabled", () => {
  it("defaults to true and honors an explicit false", async () => {
    const { mkdtempSync, rmSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const home = mkdtempSync(join(tmpdir(), "handbook-gateauto-"));
    try {
      expect(gateAutoEnabled(home)).toBe(true);
      writeFileSync(join(home, "config.json"), JSON.stringify({ gate: { auto: false } }));
      expect(gateAutoEnabled(home)).toBe(false);
      writeFileSync(join(home, "config.json"), JSON.stringify({ gate: { auto: true } }));
      expect(gateAutoEnabled(home)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("gateAutoEnabled fail-closed (B4)", () => {
  it("returns false when config.json exists but cannot be parsed", () => {
    const home = mkdtempSync(join(tmpdir(), "handbook-cfg-"));
    try {
      // a hand-edited file with a trailing comma must never silently re-enable sending
      writeFileSync(join(home, "config.json"), '{"harvest":{"enabled":false},"gate":{"auto":false},}');
      expect(gateAutoEnabled(home)).toBe(false);
      expect(loadHarvestConfig(home).enabled).toBe(false);
      // a MISSING file is the normal first-run state → defaults (enabled)
      rmSync(join(home, "config.json"));
      expect(gateAutoEnabled(home)).toBe(true);
      expect(loadHarvestConfig(home).enabled).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("runClaudeCli against a real claude process", () => {
  let bin: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "handbook-bin-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
  });

  /** A stand-in `claude` on PATH. The real binary is never called from a test. */
  function fakeClaude(script: string): void {
    const file = join(bin, "claude");
    writeFileSync(file, script, { mode: 0o755 });
  }

  const STDIN_WARNING =
    "Warning: no stdin data received in 3s, proceeding without it. If piping from a slow command, redirect stdin explicitly: < /dev/null to skip, or wait longer.";

  it("given a claude that warns on stderr and exits 0, when the runner calls it, then the run succeeds", async () => {
    fakeClaude(`#!/bin/sh\nprintf '${STDIN_WARNING}\\n' >&2\nprintf 'the reply\\n'\nexit 0\n`);
    await expect(runClaudeCli("prompt", "haiku", 20_000)).resolves.toBe("the reply\n");
  });

  it("given a claude that colorizes that warning, when the runner calls it, then the run still succeeds", async () => {
    fakeClaude(`#!/bin/sh\nprintf '\\033[33m${STDIN_WARNING}\\033[39m\\n' >&2\nprintf 'the reply\\n'\nexit 0\n`);
    await expect(runClaudeCli("prompt", "haiku", 20_000)).resolves.toBe("the reply\n");
  });

  it("given a claude that exits non-zero, when the runner calls it, then it throws and the reason names the exit code, not the warning", async () => {
    fakeClaude(`#!/bin/sh\nprintf '${STDIN_WARNING}\\n' >&2\nexit 3\n`);
    const err = await runClaudeCli("prompt", "haiku", 20_000).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const reason = claudeErrorReason(err);
    expect(reason).toContain("exited with code 3");
    expect(reason).not.toContain("no stdin data");
  });

  it("given a claude that fails with a real message, when the runner calls it, then that message is the reason", async () => {
    fakeClaude(`#!/bin/sh\nprintf '${STDIN_WARNING}\\n' >&2\nprintf 'Invalid API key\\n' >&2\nexit 1\n`);
    const err = await runClaudeCli("prompt", "haiku", 20_000).catch((e: unknown) => e);
    expect(claudeErrorReason(err)).toBe("Invalid API key");
  });

  it("given a claude that reports what it found on stdin, when the runner calls it, then stdin is already closed", async () => {
    // The defect this proves: execFile leaves the child's stdin an open pipe, so the
    // CLI waits on input that is never coming and warns about it on every single call.
    fakeClaude(
      `#!/usr/bin/env node\n` +
        `let ended = false;\n` +
        `process.stdin.on("end", () => { ended = true; process.stdout.write("STDIN_CLOSED"); process.exit(0); });\n` +
        `setTimeout(() => { if (!ended) { process.stdout.write("STDIN_LEFT_OPEN"); process.exit(0); } }, 3000);\n` +
        `process.stdin.resume();\n`,
    );
    await expect(runClaudeCli("prompt", "haiku", 20_000)).resolves.toBe("STDIN_CLOSED");
  });

  it("given a claude that writes past the output cap, when the runner calls it, then the reason names the cap and not a timeout", async () => {
    // node kills the child on overflow, so this error can look like the timeout branch
    // right below it; the whole point of this commit is that the reason names the knob
    // the user actually has to turn
    fakeClaude(`#!/usr/bin/env node\nprocess.stdout.write("x".repeat(2 * 1024 * 1024));\n`);
    const err = await runClaudeCli("prompt", "haiku", 20_000).catch((e: unknown) => e);
    const reason = claudeErrorReason(err);
    expect(reason).toContain("1 MB output cap");
    expect(reason).not.toContain("timed out");
  });

  it("given no claude on PATH at all, when the runner calls it, then the reason says so instead of crashing the runner", async () => {
    process.env.PATH = bin; // empty dir: nothing to find
    const err = await runClaudeCli("prompt", "haiku", 20_000).catch((e: unknown) => e);
    expect(claudeErrorReason(err)).toContain("claude CLI not found on PATH");
  });
});

// The name of an existing skill becomes a LABEL of the fenced dedup block, and a label is
// the only text the fence allows at column 0. These are not attack strings: they are the
// name shapes a real marketplace ships, and they have to keep labelling their own
// description rather than being moved into the value.
describe("skill names as fence labels", () => {
  const SAFE = [
    "suggest-skill-capture",
    "release-tag-first",
    "testcontainers-postgres-tests",
    "handbook-review",
    "n8n-webhook-retry",
    "a",
    "skill2",
  ];
  const signal = {
    ts: "2026-01-01T00:00:00.000Z",
    sessionId: "s",
    kind: "candidate" as const,
    fingerprint: "a1b2c3d4e5f60718",
    family: "npm",
    command: "npm test",
    error: "1 failed",
    cwd: "/fixture/workspace",
    count: 1,
    edits: ["src/lib/example.ts"],
    resolvedCommand: "npm run build && npm test",
  };
  const labelsOf = (prompt: string): string[] =>
    prompt.split("\n").filter((l) => /^[^\s].*:$/.test(l) && !l.startsWith("<<<"));

  it("given ordinary kebab-case names, when the prompt is built, then each labels its own description", () => {
    const prompt = buildScorePrompt(
      signal,
      1,
      SAFE.map((name) => ({ name, description: `Use when ${name} applies.` })),
    );
    for (const name of SAFE) {
      expect(labelsOf(prompt), name).toContain(`${name}:`);
      expect(prompt).toContain(`${name}:\n  Use when ${name} applies.`);
    }
    expect(prompt).not.toContain("not usable as a label");
  });

  it("given a name that cannot be a label, when the prompt is built, then it moves into the value and keeps its description", () => {
    // A legitimate but non-kebab name is treated the same way as a hostile one. That is
    // the trade sweep.ts already makes, and it is the reason this case is written down.
    const prompt = buildScorePrompt(signal, 1, [
      { name: "Deploy Checklist", description: "Use when shipping." },
      { name: "team:review", description: "Use when reviewing." },
    ]);
    expect(labelsOf(prompt)).toContain("(skill name not usable as a label #1, listed as data):");
    expect(labelsOf(prompt)).toContain("(skill name not usable as a label #2, listed as data):");
    expect(labelsOf(prompt)).not.toContain("Deploy Checklist:");
    // nothing is lost: both the name and its description are still readable, as data
    expect(prompt).toContain("  name: Deploy Checklist");
    expect(prompt).toContain("  description: Use when shipping.");
    expect(prompt).toContain("  name: team:review");
  });

  it("given two unusable names, when the prompt is built, then neither replaces the other", () => {
    const prompt = buildScorePrompt(signal, 1, [
      { name: "One Two", description: "first" },
      { name: "Three Four", description: "second" },
    ]);
    expect(prompt).toContain("first");
    expect(prompt).toContain("second");
  });
});

// What the model call is ALLOWED to do, measured on the argument list and the environment
// the child actually receives. Before this, `claude -p` inherited the lot: tools, MCP
// servers, local settings, the repository as its working directory, and the whole
// environment. The fence decides what the prompt says; only this decides what an obeying
// child could do about it.
describe("the model call runs isolated", () => {
  let bin: string;
  let out: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "handbook-bin-"));
    out = mkdtempSync(join(tmpdir(), "handbook-out-"));
    originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
  });

  afterEach(() => {
    process.env.PATH = originalPath;
    rmSync(bin, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });

  /** A stand-in `claude` that advertises the isolation flags in --help and, for any other
   * call, records what it was handed. The real binary is never called from a test. */
  function recordingClaude(): void {
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--help" ]; then',
        '  printf -- "Options:\\n  --tools <tools...>\\n  --strict-mcp-config\\n  --restricted\\n"',
        "  exit 0",
        "fi",
        `printf '%s\\n' "$@" > ${JSON.stringify(join(out, "args"))}`,
        `pwd > ${JSON.stringify(join(out, "cwd"))}`,
        `env > ${JSON.stringify(join(out, "env"))}`,
        "printf 'the reply\\n'",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  /** A stand-in whose --help knows none of the flags: an older Claude Code. */
  function oldClaude(): void {
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--help" ]; then printf -- "Options:\\n  --model <model>\\n"; exit 0; fi',
        `printf '%s\\n' "$@" > ${JSON.stringify(join(out, "args"))}`,
        "printf 'the reply\\n'",
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  /** `printf '%s\n' "$@"` puts one argument per line, so an EMPTY argument is an empty
   * line - and "--tools" with an empty value is exactly the argument under test. Only the
   * trailing newline is dropped, never blank lines. */
  const argsGiven = (): string[] => {
    const lines = readFileSync(join(out, "args"), "utf8").split("\n");
    return lines.slice(0, -1);
  };

  it("given a claude that supports the flags, when the runner calls it, then the child gets no tools, no MCP servers and no local settings", async () => {
    recordingClaude();
    await expect(runClaudeCli("prompt", "haiku", 20_000)).resolves.toBe("the reply\n");
    const given = argsGiven();
    expect(given).toContain("--tools");
    expect(given).toContain("--strict-mcp-config");
    expect(given).toContain("--restricted");
    // "--tools" is followed by the empty string, which is how the CLI spells "no tools"
    expect(given[given.indexOf("--tools") + 1]).toBe("");
  });

  it("given a claude that supports the flags, when the runner calls it, then the working directory is empty and is not the project", async () => {
    recordingClaude();
    await runClaudeCli("prompt", "haiku", 20_000);
    const childCwd = readFileSync(join(out, "cwd"), "utf8").trim();
    expect(childCwd).not.toBe(process.cwd());
    // nothing of ours is reachable from it: no CLAUDE.md, no package.json, no .claude
    for (const name of ["CLAUDE.md", "package.json", ".claude", "src"]) {
      expect(existsSync(join(childCwd, name)), name).toBe(false);
    }
  });

  it("given a variable that is not on the allowlist, when the runner calls it, then the child never sees it", async () => {
    recordingClaude();
    process.env.TEAMHANDBOOK_TEST_DECOY = "decoy-value-that-must-not-travel";
    try {
      await runClaudeCli("prompt", "haiku", 20_000);
    } finally {
      delete process.env.TEAMHANDBOOK_TEST_DECOY;
    }
    const childEnvText = readFileSync(join(out, "env"), "utf8");
    expect(childEnvText).not.toContain("decoy-value-that-must-not-travel");
    // …while what the CLI needs is still there
    expect(childEnvText).toMatch(/^PATH=/m);
    expect(childEnvText).toMatch(/^HOME=/m);
  });

  it("given an older claude without the flags, when the runner calls it, then the call still runs rather than failing", async () => {
    // Failing closed here would mean no harvest at all on an older CLI. The state is
    // reported by /handbook:doctor instead, which is what checkChildIsolation is for.
    oldClaude();
    await expect(runClaudeCli("prompt", "haiku", 20_000)).resolves.toBe("the reply\n");
    expect(argsGiven()).not.toContain("--restricted");
  });

  it("given a help text with only some of the flags, when the args are decided, then none are used", () => {
    expect(childIsolationArgsFor("  --tools <tools...>\n  --restricted\n")).toEqual([]);
    expect(
      childIsolationArgsFor("  --tools <tools...>\n  --strict-mcp-config\n  --restricted\n"),
    ).not.toEqual([]);
  });

  it("given a help that only MENTIONS a flag in another option's prose, when the args are decided, then it does not count as declared", () => {
    // The real CLI does exactly this: `--restricted`'s description reads "... and WebFetch
    // unless --tools names them". Reading that as support passes `--tools` to a CLI that
    // may not have it, and the call dies with `unknown option`.
    const helpWithProse = [
      "  --restricted                    Restricted mode: removes the built-in",
      "                                  tools that run commands or code and",
      "                                  WebFetch unless --tools names them, and",
      "                                  ignores settings files (add",
      "                                  --strict-mcp-config to skip MCP too).",
      "  --model <model>                 Model for this session",
    ].join("\n");
    expect(childIsolationArgsFor(helpWithProse)).toEqual([]);
  });

  it("given a flag named only in the description that shares an option's line, when the args are decided, then it does not count", () => {
    // The real shape of the bug: the description sits on the SAME row as the option it
    // belongs to, so taking every flag on the row read `--tools` off --restricted's prose.
    const sameLine = [
      "  --restricted              Restricted mode: removes tools unless --tools names them, and --strict-mcp-config skips MCP",
      "  --model <model>           Model for this session",
    ].join("\n");
    expect(childIsolationArgsFor(sameLine)).toEqual([]);
  });

  it("given a help with options at column zero, when the args are decided, then they are still found", () => {
    // Missing indent-0 options used to make the whole list invisible, which passed NO
    // restricting flags at all - silence in the dangerous direction.
    const flush = ["--tools <tools...>", "--strict-mcp-config", "--restricted"].join("\n");
    expect(helpFormatRecognized(flush)).toBe(true);
    expect(childIsolationArgsFor(flush)).not.toEqual([]);
  });

  it("given a help this parser cannot read at all, when the args are decided, then it falls back rather than silently dropping the restriction", () => {
    const prose = "Claude Code. Use the tools option to limit tools. See --tools, --strict-mcp-config, --restricted.";
    expect(helpFormatRecognized(prose)).toBe(false);
    // too generous is recoverable - the call fails loudly on an unknown option; too strict
    // is not, because the call succeeds unrestricted and nothing says so
    expect(childIsolationArgsFor(prose)).not.toEqual([]);
  });

  it("given the real help's two-column shape, when the args are decided, then the declared options are found", () => {
    // the option column is measured, not assumed, so a reformatted help still parses
    const wide = [
      "Options:",
      "      --tools <tools...>                Specify the list of available tools",
      "      --strict-mcp-config               Only use MCP servers from --mcp-config",
      "      --restricted                      Restricted mode",
      "                                        -- see also --tools",
    ].join("\n");
    expect(childIsolationArgsFor(wide)).not.toEqual([]);
  });
});

// The bug this guards against was measured, not imagined: the isolated call carried
// ANTHROPIC_* but no cloud-backend family, so on a machine authenticating through Bedrock
// the harvest died with "Unable to locate credentials" while /handbook:doctor - still
// passing the FULL environment - reported the CLI as authenticated. The two paths now build
// their invocation from one function, so a test that makes them disagree has to fail.
describe("the harvest and the doctor reach the model the same way", () => {
  let bin: string;
  let home: string;
  let saved: Record<string, string | undefined> = {};

  const HELP = [
    "Options:",
    "  --tools <tools...>        Specify the list of available tools",
    "  --strict-mcp-config       Only use MCP servers from --mcp-config",
    "  --restricted              Restricted mode",
    "  --model <model>           Model for this session",
    "",
  ].join("\n");

  /**
   * A CLI that behaves like a real cloud-backed install, in the two ways that make the
   * "both paths are the same" claim testable at all:
   *
   *  - it takes its credentials from the ENVIRONMENT, so an environment missing them fails;
   *  - it REFUSES to run while a parent session's messaging token is in the environment.
   *
   * The second is what makes the claim falsifiable. Without it, the fixture authenticated
   * under both the restricted environment and the full one, so a probe that wrongly used
   * the full environment still passed and the test proved nothing - measured: mutating the
   * doctor back to `process.env` left the whole package green.
   */
  function environmentAuthClaude(): void {
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then printf "2.9.9 (Claude Code)\\n"; exit 0; fi',
        // %b, not %s: the help must arrive as real LINES, because the option column is
        // what tells the flag detection an option from a mention in someone's prose
        `if [ "$1" = "--help" ]; then printf '%b' ${JSON.stringify(HELP)}; exit 0; fi`,
        'if [ "$1" = "mcp" ]; then printf "\\n"; exit 0; fi',
        'if [ -n "$CLAUDE_CODE_MESSAGING_TOKEN" ]; then',
        '  printf "refusing to run attached to a parent session\\n" >&2',
        "  exit 1",
        "fi",
        // a gateway install signs nothing itself, so the skip switch stands in for the key
        'if [ -z "$AWS_SECRET_ACCESS_KEY" ] && [ -z "$CLAUDE_CODE_SKIP_BEDROCK_AUTH" ]; then',
        '  printf "Unable to locate credentials for Bedrock\\n" >&2',
        "  exit 1",
        "fi",
        'printf "OK\\n"',
      ].join("\n"),
      { mode: 0o755 },
    );
  }

  beforeEach(() => {
    bin = mkdtempSync(join(tmpdir(), "handbook-bin-"));
    home = mkdtempSync(join(tmpdir(), "handbook-home-"));
    saved = {
      PATH: process.env.PATH,
      AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
      CLAUDE_CODE_USE_BEDROCK: process.env.CLAUDE_CODE_USE_BEDROCK,
      CLAUDE_CODE_SKIP_BEDROCK_AUTH: process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH,
      CLAUDE_CODE_MESSAGING_TOKEN: process.env.CLAUDE_CODE_MESSAGING_TOKEN,
    };
    process.env.PATH = `${bin}:${process.env.PATH ?? ""}`;
    process.env.AWS_SECRET_ACCESS_KEY = "fixture-key-not-a-real-credential";
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    // present in the PARENT, and the fixture refuses to run while it is set: this is what
    // makes a probe through the full environment fail and a probe through childEnv pass
    process.env.CLAUDE_CODE_MESSAGING_TOKEN = "fixture-parent-session-token";
    environmentAuthClaude();
  });

  afterEach(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(bin, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  });

  it("given a CLI that authenticates from the environment, when the harvest calls it, then the call succeeds", async () => {
    await expect(runClaudeCli("prompt", "haiku", 20_000)).resolves.toContain("OK");
  });

  it("given the same CLI, when the doctor probes it, then it agrees rather than certifying a path that fails", () => {
    const report = runDoctor(home, runCommand);
    const cli = report.checks.find((c) => c.name === "claude CLI");
    const isolation = report.checks.find((c) => c.name === "model call isolation");
    expect(cli?.level).toBe("ok");
    expect(isolation?.level).toBe("ok");
    expect(isolation?.detail).toContain("verified by a real call");
  });

  it("given a gateway install that signs nothing itself, when the harvest calls it, then the skip switch reaches the child", async () => {
    // The failure mode of the previous, shorter allowlist: the switch was refused, the
    // child tried to sign the request with a key it did not have, and the call died.
    delete process.env.AWS_SECRET_ACCESS_KEY;
    process.env.CLAUDE_CODE_SKIP_BEDROCK_AUTH = "1";
    await expect(runClaudeCli("prompt", "haiku", 20_000)).resolves.toContain("OK");
    expect(runDoctor(home, runCommand).checks.find((c) => c.name === "claude CLI")?.level).toBe("ok");
  });

  it("given the probe runs, when it does, then its working directory is empty and is not the project", () => {
    const pwdFile = join(home, "probe-cwd");
    writeFileSync(
      join(bin, "claude"),
      [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then printf "2.9.9 (Claude Code)\\n"; exit 0; fi',
        `if [ "$1" = "--help" ]; then printf '%b' ${JSON.stringify(HELP)}; exit 0; fi`,
        'if [ "$1" = "mcp" ]; then printf "\\n"; exit 0; fi',
        `pwd > ${JSON.stringify(pwdFile)}`,
        'printf "OK\\n"',
      ].join("\n"),
      { mode: 0o755 },
    );
    runDoctor(home, runCommand);
    const probeCwd = readFileSync(pwdFile, "utf8").trim();
    expect(probeCwd).not.toBe(process.cwd());
    for (const name of ["CLAUDE.md", "package.json", "src", ".claude"]) {
      expect(existsSync(join(probeCwd, name)), name).toBe(false);
    }
  });

  it("given the credentials are missing, when both are asked, then BOTH report the failure", async () => {
    delete process.env.AWS_SECRET_ACCESS_KEY;
    await expect(runClaudeCli("prompt", "haiku", 20_000)).rejects.toThrow();
    const report = runDoctor(home, runCommand);
    expect(report.checks.find((c) => c.name === "claude CLI")?.level).not.toBe("ok");
    // and the isolation line must not claim success on the back of a failed call
    expect(report.checks.find((c) => c.name === "model call isolation")?.level).not.toBe("ok");
  });
});

// Which variables the child inherits, named individually. The allowed ones are here because
// the CLI cannot reach the model without them; the refused ones because they tie the child
// back to the interactive session whose text is the untrusted input.
describe("the child environment", () => {
  const source = {
    // must pass: the CLI cannot work without these
    PATH: "/usr/bin",
    HOME: "/fixture/home",
    TZ: "Europe/Istanbul",
    LC_ALL: "en_US.UTF-8",
    ANTHROPIC_API_KEY: "fixture-anthropic",
    AWS_SECRET_ACCESS_KEY: "fixture-aws",
    AWS_REGION: "eu-central-1",
    GOOGLE_APPLICATION_CREDENTIALS: "/fixture/gcp.json",
    GCLOUD_PROJECT: "fixture-project",
    AZURE_TENANT_ID: "fixture-tenant",
    CLOUD_ML_REGION: "europe-west1",
    HTTPS_PROXY: "http://proxy.invalid:8080",
    ALL_PROXY: "http://proxy.invalid:8080",
    NODE_EXTRA_CA_CERTS: "/fixture/ca.pem",
    REQUESTS_CA_BUNDLE: "/fixture/ca.pem",
    SSL_CERT_DIR: "/fixture/certs",
    CLAUDE_CODE_USE_BEDROCK: "1",
    CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    CLAUDE_CODE_OAUTH_REFRESH_TOKEN: "fixture-refresh",
    CLAUDE_CONFIG_DIR: "/fixture/config",
    // a gateway install: the token, the endpoint, and the switches that say the gateway
    // already signed the request. Measured from the installed binary.
    CLAUDE_CODE_GATEWAY_TOKEN: "fixture-gateway",
    CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR: "3",
    CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
    CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
    CLAUDE_CODE_SKIP_FOUNDRY_AUTH: "1",
    CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH: "1",
    CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH: "1",
    CLAUDE_CODE_SKIP_MANTLE_AUTH: "1",
    CLAUDE_CODE_API_BASE_URL: "https://gateway.invalid",
    CLAUDE_CODE_HTTP_PROXY: "http://proxy.invalid:8080",
    CLAUDE_CODE_HTTPS_PROXY: "http://proxy.invalid:8080",
    CLAUDE_CODE_PROXY_AUTHENTICATE: "1",
    CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER: "1",
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: "4",
    CLAUDE_CODE_API_KEY_HELPER_TTL_MS: "60000",
    CLAUDE_CODE_CLIENT_KEY: "/fixture/client.key",
    CLAUDE_CODE_CLIENT_KEY_PASSPHRASE: "fixture-passphrase",
    CLAUDE_CODE_HOST_CREDS_FILE: "/fixture/host-creds",
    CLOUDSDK_AUTH_ACCESS_TOKEN: "fixture-cloudsdk",
    CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE: "/fixture/gcp-ca.pem",
    TEMP: "C:\\Temp",
    TMP: "C:\\Temp",
    TEAMHANDBOOK_HOME: "/fixture/handbook",
    USERPROFILE: "C:\\Users\\fixture",
    APPDATA: "C:\\Users\\fixture\\AppData",

    // must NOT pass: handles on the parent interactive session
    CLAUDE_CODE_MESSAGING_SOCKET: "/fixture/socket",
    CLAUDE_CODE_MESSAGING_TOKEN: "fixture-messaging-token",
    CLAUDE_SESSION_ID: "fixture-session",
    CLAUDE_EFFORT: "high",
    CLAUDE_CODE_CLIENT_DATA_URL: "https://fixture.invalid",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    // must NOT pass: nothing to do with reaching a model
    GITHUB_TOKEN: "fixture-github",
    NPM_TOKEN: "fixture-npm",
    SSH_AUTH_SOCK: "/fixture/ssh-agent",
    AN_UNRELATED_VARIABLE: "whatever",
    // must NOT pass: the only two variables that could hand an isolated child new code or
    // take its certificate checking away
    NODE_OPTIONS: "--require /fixture/evil.js",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    // must NOT pass: tokens of features this call does not use
    CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN: "fixture-mcp",
    CLAUDE_CODE_MEMORY_API_TOKEN: "fixture-memory",
  };

  const PASSES = [
    "PATH", "HOME", "TZ", "LC_ALL", "ANTHROPIC_API_KEY", "AWS_SECRET_ACCESS_KEY",
    "AWS_REGION", "GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_PROJECT", "AZURE_TENANT_ID",
    "CLOUD_ML_REGION", "HTTPS_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS",
    "REQUESTS_CA_BUNDLE", "SSL_CERT_DIR", "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "TEAMHANDBOOK_HOME",
    "USERPROFILE", "APPDATA",
    "CLAUDE_CODE_OAUTH_REFRESH_TOKEN", "CLAUDE_CODE_GATEWAY_TOKEN",
    "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR", "CLAUDE_CODE_SKIP_BEDROCK_AUTH",
    "CLAUDE_CODE_SKIP_VERTEX_AUTH", "CLAUDE_CODE_SKIP_FOUNDRY_AUTH",
    "CLAUDE_CODE_SKIP_ANTHROPIC_AWS_AUTH", "CLAUDE_CODE_SKIP_ANTHROPIC_GOOGLE_CLOUD_AUTH",
    "CLAUDE_CODE_SKIP_MANTLE_AUTH", "CLAUDE_CODE_API_BASE_URL", "CLAUDE_CODE_HTTP_PROXY",
    "CLAUDE_CODE_HTTPS_PROXY", "CLAUDE_CODE_PROXY_AUTHENTICATE",
    "CLAUDE_CODE_ENABLE_PROXY_AUTH_HELPER", "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_API_KEY_HELPER_TTL_MS", "CLAUDE_CODE_CLIENT_KEY",
    "CLAUDE_CODE_CLIENT_KEY_PASSPHRASE", "CLAUDE_CODE_HOST_CREDS_FILE",
    "CLOUDSDK_AUTH_ACCESS_TOKEN", "CLOUDSDK_CORE_CUSTOM_CA_CERTS_FILE", "TEMP", "TMP",
  ];

  const REFUSED = [
    "CLAUDE_CODE_MESSAGING_SOCKET", "CLAUDE_CODE_MESSAGING_TOKEN", "CLAUDE_SESSION_ID",
    "CLAUDE_EFFORT", "CLAUDE_CODE_CLIENT_DATA_URL", "CLAUDE_CODE_ENTRYPOINT",
    "GITHUB_TOKEN", "NPM_TOKEN", "SSH_AUTH_SOCK", "AN_UNRELATED_VARIABLE",
    "NODE_OPTIONS", "NODE_TLS_REJECT_UNAUTHORIZED",
    "CLAUDE_CODE_MCP_SERVE_AUTH_TOKEN", "CLAUDE_CODE_MEMORY_API_TOKEN",
  ];

  it.each(PASSES)("%s reaches the child, because the call needs it", (name) => {
    expect(Object.keys(childEnv(source))).toContain(name);
  });

  it.each(REFUSED)("%s does not reach the child", (name) => {
    expect(Object.keys(childEnv(source))).not.toContain(name);
  });

  it("given the CLI designates another variable as its credential, when the environment is built, then that name comes too", () => {
    // CLAUDE_CODE_HOST_AUTH_ENV_VAR holds the NAME of the variable holding the credential.
    // Without honouring it, a host-credential install passes the pointer and loses what it
    // points at.
    const env = childEnv({
      CLAUDE_CODE_HOST_AUTH_ENV_VAR: "MY_HOST_TOKEN",
      MY_HOST_TOKEN: "fixture-host-token",
      SOME_OTHER_TOKEN: "must-not-travel",
    });
    expect(env.CLAUDE_CODE_HOST_AUTH_ENV_VAR).toBe("MY_HOST_TOKEN");
    expect(env.MY_HOST_TOKEN).toBe("fixture-host-token");
    expect(env.SOME_OTHER_TOKEN).toBeUndefined();
  });

  it("given a CLAUDE_ name nobody has listed, when the environment is built, then it is refused by default", () => {
    // deny by default, so a variable that does not exist yet cannot arrive as an allowance
    expect(Object.keys(childEnv({ CLAUDE_SOMETHING_NEW: "x" }))).toEqual([]);
  });

  it("covers every variable in the fixture, so neither list can silently go stale", () => {
    expect([...PASSES, ...REFUSED].sort()).toEqual(Object.keys(source).sort());
  });
});
