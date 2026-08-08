import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assembleSkillMd,
  buildDistillPrompt,
  buildGroundedCase,
  defaultDistillConfig,
  distillVerdict,
  loadDistillConfig,
  normalizeRemoteUrl,
  parseDistillResponse,
  relativizeEdits,
  resolveScope,
  slugifySkillName,
  writeCandidate,
} from "./distill.js";
import type { SkillArtifact } from "./distill.js";
import type { GateVerdict, ScoreResult } from "./score.js";
import type { Signal } from "./signals.js";
import { parseSkillFrontmatter } from "./skill-index.js";

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
    edits: ["/repo/src/app.ts"],
    resolvedCommand: "npm test",
    resolvedAt: "2026-08-08T00:10:00Z",
    ...overrides,
  };
}

function scoreResult(overrides: Partial<ScoreResult> = {}): ScoreResult {
  return {
    scores: { recurrence: 2, unfindability: 2, generality: 2, durability: 2, costOfError: 2 },
    total: 10,
    pass: true,
    ...overrides,
  };
}

function promoted(signal: Signal = candidate(), result: ScoreResult = scoreResult()): GateVerdict {
  return { signal, outcome: "promote", result };
}

const validResponse = JSON.stringify({
  name: "Fix Flaky NPM Test",
  description: "Use when npm test fails with a stale snapshot.",
  body: "## Symptom\n\nTest fails.\n\n## Fix\n\nUpdate the snapshot.",
  expect: "npm test exits 0 after the snapshot update.",
});

describe("normalizeRemoteUrl", () => {
  it.each([
    ["git@gitlab.x.com:ekip/bff.git", "gitlab.x.com/ekip/bff"],
    ["https://gitlab.x.com/ekip/bff.git", "gitlab.x.com/ekip/bff"],
    ["https://user@github.com/Org/Repo.git", "github.com/Org/Repo"],
    ["ssh://git@gitlab.x.com/ekip/bff.git", "gitlab.x.com/ekip/bff"],
    ["ssh://git@gitlab.x.com:2222/ekip/bff.git", "gitlab.x.com:2222/ekip/bff"],
    ["HTTPS://GitLab.X.com/ekip/bff/", "gitlab.x.com/ekip/bff"],
  ])("normalizes %s to %s", (raw, expected) => {
    expect(normalizeRemoteUrl(raw)).toBe(expected);
  });

  it("keeps the repo path case while lowercasing only the host", () => {
    expect(normalizeRemoteUrl("git@GitHub.com:Team/MyRepo.git")).toBe("github.com/Team/MyRepo");
  });

  it.each([
    ["empty", ""],
    ["whitespace", "   "],
    ["host only", "gitlab.x.com"],
    ["host with trailing slash only", "gitlab.x.com/"],
  ])("returns null on %s", (_label, raw) => {
    expect(normalizeRemoteUrl(raw)).toBeNull();
  });
});

describe("resolveScope", () => {
  it("returns team when generality is maximal", () => {
    expect(resolveScope(2, "gitlab.x.com/ekip/bff")).toBe("team");
  });

  it("returns the normalized remote for project-local knowledge", () => {
    expect(resolveScope(1, "gitlab.x.com/ekip/bff")).toBe("gitlab.x.com/ekip/bff");
  });

  it("falls back to team when no remote is available", () => {
    expect(resolveScope(0, null)).toBe("team");
  });
});

describe("slugifySkillName", () => {
  it("kebab-cases arbitrary names", () => {
    expect(slugifySkillName("Fix Flaky NPM Test!")).toBe("fix-flaky-npm-test");
  });

  it("caps the slug at 64 chars without a trailing dash", () => {
    const slug = slugifySkillName("a".repeat(63) + " b");
    expect(slug).toHaveLength(63);
    expect(slug!.endsWith("-")).toBe(false);
  });

  it("returns null when nothing slug-safe remains", () => {
    expect(slugifySkillName("!!!")).toBeNull();
  });
});

describe("buildDistillPrompt", () => {
  it("includes the case facts and the ledger occurrence count", () => {
    const prompt = buildDistillPrompt(candidate(), 4);
    expect(prompt).toContain("failed command: npm test");
    expect(prompt).toContain("error (normalized): 1 test failed");
    expect(prompt).toContain("files edited for the fix: /repo/src/app.ts");
    expect(prompt).toContain("seen in the local ledger: 4");
  });

  it("demands a JSON-only reply with the four fields in English", () => {
    const prompt = buildDistillPrompt(candidate(), 1);
    expect(prompt).toContain("ONLY a JSON object");
    for (const field of ['"name"', '"description"', '"body"', '"expect"']) {
      expect(prompt).toContain(field);
    }
    expect(prompt).toContain("in English");
  });
});

describe("parseDistillResponse", () => {
  it("slugifies the name and normalizes whitespace", () => {
    const draft = parseDistillResponse(validResponse);
    expect(draft).toMatchObject({
      slug: "fix-flaky-npm-test",
      description: "Use when npm test fails with a stale snapshot.",
      expect: "npm test exits 0 after the snapshot update.",
    });
    expect(draft?.body).toContain("## Symptom");
  });

  it("extracts JSON wrapped in a code fence", () => {
    expect(parseDistillResponse("```json\n" + validResponse + "\n```")).not.toBeNull();
  });

  it("collapses newlines in the description", () => {
    const response = validResponse.replace(
      "Use when npm test fails with a stale snapshot.",
      "Use when\\nnpm test fails.",
    );
    expect(parseDistillResponse(response)?.description).toBe("Use when npm test fails.");
  });

  it.each([
    ["no JSON", "cannot help"],
    ["invalid JSON", "{name: broken}"],
    ["missing field", '{"name": "x", "description": "y", "body": "z"}'],
    ["empty field", validResponse.replace('"npm test exits 0 after the snapshot update."', '"  "')],
    ["unslugifiable name", validResponse.replace("Fix Flaky NPM Test", "!!!")],
  ])("returns null on %s", (_label, text) => {
    expect(parseDistillResponse(text)).toBeNull();
  });
});

describe("assembleSkillMd", () => {
  it("produces spec-compliant frontmatter with the scope tag", () => {
    const draft = parseDistillResponse(validResponse)!;
    const md = assembleSkillMd(draft, "gitlab.x.com/ekip/bff");
    expect(md.startsWith("---\nname: fix-flaky-npm-test\n")).toBe(true);
    expect(md).toContain('description: "Use when npm test fails with a stale snapshot."');
    expect(md).toContain('scope: "gitlab.x.com/ekip/bff"');
    expect(md).toContain("## Grounded case");
    expect(md).toContain("grounded-case.json");
    expect(parseSkillFrontmatter(md)).toEqual({
      name: "fix-flaky-npm-test",
      description: "Use when npm test fails with a stale snapshot.",
      scope: "gitlab.x.com/ekip/bff",
    });
  });

  it("escapes quotes in the description", () => {
    const draft = { ...parseDistillResponse(validResponse)!, description: 'needs "camelCase" keys' };
    expect(assembleSkillMd(draft, "team")).toContain('description: "needs \\"camelCase\\" keys"');
  });
});

describe("relativizeEdits", () => {
  it("strips the cwd prefix and leaves outside paths untouched", () => {
    expect(relativizeEdits(["/repo/src/app.ts", "/etc/hosts"], "/repo")).toEqual([
      "src/app.ts",
      "/etc/hosts",
    ]);
  });
});

describe("buildGroundedCase", () => {
  it("captures the originating case, expect, and gate score", () => {
    const grounded = buildGroundedCase(candidate(), promoted(), "npm test exits 0.");
    expect(grounded).toEqual({
      fingerprint: "abc123",
      capturedAt: "2026-08-08T00:00:00Z",
      command: "npm test",
      error: "1 test failed",
      resolvedCommand: "npm test",
      edits: ["src/app.ts"],
      expect: "npm test exits 0.",
      gate: { total: 10, scores: scoreResult().scores },
    });
  });

  it("uses null for a missing resolution and gate result", () => {
    const verdict: GateVerdict = { signal: candidate({ resolvedCommand: undefined }), outcome: "promote" };
    const grounded = buildGroundedCase(verdict.signal, verdict, "x");
    expect(grounded.resolvedCommand).toBeNull();
    expect(grounded.gate).toBeNull();
  });
});

describe("distillVerdict", () => {
  it("distills a promoted signal into a scoped artifact", async () => {
    const outcome = await distillVerdict(
      promoted(),
      3,
      defaultDistillConfig,
      async () => validResponse,
      () => "git@gitlab.x.com:ekip/bff.git",
    );
    expect(outcome.outcome).toBe("distilled");
    expect(outcome.artifact).toMatchObject({ slug: "fix-flaky-npm-test", scope: "team" });
    expect(outcome.artifact?.groundedCase.expect).toBe("npm test exits 0 after the snapshot update.");
  });

  it("scopes to the project remote when generality is below maximal", async () => {
    const verdict = promoted(
      candidate(),
      scoreResult({ scores: { recurrence: 2, unfindability: 2, generality: 1, durability: 2, costOfError: 2 }, total: 9 }),
    );
    const outcome = await distillVerdict(
      verdict,
      3,
      defaultDistillConfig,
      async () => validResponse,
      () => "git@gitlab.x.com:ekip/bff.git",
    );
    expect(outcome.artifact?.scope).toBe("gitlab.x.com/ekip/bff");
  });

  it("falls back to team scope in a directory without a remote", async () => {
    const verdict = promoted(
      candidate(),
      scoreResult({ scores: { recurrence: 2, unfindability: 2, generality: 0, durability: 2, costOfError: 2 }, total: 8 }),
    );
    const outcome = await distillVerdict(verdict, 3, defaultDistillConfig, async () => validResponse, () => null);
    expect(outcome.artifact?.scope).toBe("team");
  });

  it("refuses signals the gate did not promote", async () => {
    const outcome = await distillVerdict(
      { signal: candidate(), outcome: "reject" },
      3,
      defaultDistillConfig,
      async () => validResponse,
      () => null,
    );
    expect(outcome).toMatchObject({ outcome: "error", error: "signal was not promoted by the gate" });
  });

  it("passes the configured model and timeout to the runner", async () => {
    const calls: Array<{ model: string; timeoutMs: number }> = [];
    await distillVerdict(
      promoted(),
      1,
      { model: "", timeoutMs: 4321 },
      async (_prompt, model, timeoutMs) => {
        calls.push({ model, timeoutMs });
        return validResponse;
      },
      () => null,
    );
    expect(calls).toEqual([{ model: "", timeoutMs: 4321 }]);
  });

  it("returns an error outcome when the runner throws", async () => {
    const outcome = await distillVerdict(
      promoted(),
      1,
      defaultDistillConfig,
      async () => {
        throw new Error("claude not found");
      },
      () => null,
    );
    expect(outcome.outcome).toBe("error");
    expect(outcome.error).toContain("claude not found");
  });

  it("returns an error outcome on an unparseable response", async () => {
    const outcome = await distillVerdict(promoted(), 1, defaultDistillConfig, async () => "no json", () => null);
    expect(outcome).toMatchObject({ outcome: "error", error: "unparseable distill response" });
  });
});

describe("writeCandidate", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function artifact(): SkillArtifact {
    return {
      slug: "fix-flaky-npm-test",
      scope: "team",
      skillMd: "---\nname: fix-flaky-npm-test\n---\n",
      groundedCase: buildGroundedCase(candidate(), promoted(), "npm test exits 0."),
    };
  }

  it("writes SKILL.md and grounded-case.json under candidates/<slug>", () => {
    const dir = writeCandidate(artifact(), home);
    expect(dir).toBe(join(home, "candidates", "fix-flaky-npm-test"));
    expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("fix-flaky-npm-test");
    const grounded = JSON.parse(readFileSync(join(dir, "grounded-case.json"), "utf8"));
    expect(grounded.fingerprint).toBe("abc123");
  });

  it("suffixes the directory on slug collision", () => {
    writeCandidate(artifact(), home);
    const second = writeCandidate(artifact(), home);
    expect(second).toBe(join(home, "candidates", "fix-flaky-npm-test-2"));
    expect(existsSync(join(second, "SKILL.md"))).toBe(true);
  });
});

describe("loadDistillConfig", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "handbook-test-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it("defaults to the user's default model and a long timeout", () => {
    expect(loadDistillConfig(home)).toEqual({ model: "", timeoutMs: 120_000 });
  });

  it("applies distill overrides from config.json", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ distill: { model: "opus", timeoutMs: 9000 } }));
    expect(loadDistillConfig(home)).toEqual({ model: "opus", timeoutMs: 9000 });
  });

  it("falls back per field on invalid values", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ distill: { model: 1, timeoutMs: 0 } }));
    expect(loadDistillConfig(home)).toEqual(defaultDistillConfig);
  });
});
