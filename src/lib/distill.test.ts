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
  remoteUrlForEdits,
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

  it.each([
    ["embedded newline", "https://evil.com/x\nname: hijacked"],
    ["carriage return", "https://evil.com/x\rname: hijacked"],
    ["tab", "https://evil.com/x\tfoo"],
    ["null byte", "https://evil.com/x\x00/y"],
  ])("rejects a control character in the remote (%s) so it can't break the frontmatter", (_label, raw) => {
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

describe("remoteUrlForEdits", () => {
  const umbrella: Record<string, string> = {
    "/dev/work/mcp-server/src": "git@gitlab.com:acme/mcp-server.git",
    "/dev/work/mcp-server/test": "git@gitlab.com:acme/mcp-server.git",
    "/dev/work/ai-client/src": "git@gitlab.com:acme/ai-client.git",
  };
  const lookup = (dir: string) => umbrella[dir] ?? null;

  it("finds the repository when every edit lands in the same checkout", () => {
    const remote = remoteUrlForEdits(
      ["/dev/work/mcp-server/src/Tool.kt", "/dev/work/mcp-server/test/ToolTest.kt"],
      lookup,
    );

    expect(remote).toBe("git@gitlab.com:acme/mcp-server.git");
  });

  it("refuses to guess when the session edited two repositories", () => {
    const remote = remoteUrlForEdits(
      ["/dev/work/mcp-server/src/Tool.kt", "/dev/work/ai-client/src/Chat.kt"],
      lookup,
    );

    expect(remote).toBeNull();
  });

  it("returns null when no edit is inside a repository", () => {
    expect(remoteUrlForEdits(["/tmp/scratch/note.md"], lookup)).toBeNull();
  });

  it("returns null when there were no edits at all", () => {
    expect(remoteUrlForEdits([], lookup)).toBeNull();
  });

  it("ignores relative paths, which would resolve against the runner's own directory", () => {
    expect(remoteUrlForEdits(["src/Tool.kt"], () => "git@gitlab.com:acme/wrong.git")).toBeNull();
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
    expect(prompt).toContain("failed command:\n  npm test");
    expect(prompt).toContain("error (normalized):\n  1 test failed");
    expect(prompt).toContain("files edited for the fix:\n  /repo/src/app.ts");
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

describe("buildDistillPrompt keeps the machine out of what it sends", () => {
  // Assembled rather than written out, as the fixtures above: a literal absolute home path
  // is refused on any line this repository takes in.
  const STAND_IN = "zoltan";
  const HOME = ["", "Users", STAND_IN, "work", "api"].join("/");

  it("given a case whose commands and edits are absolute, when the prompt is built, then no part of it names the machine", () => {
    const prompt = buildDistillPrompt(
      candidate({
        command: `npm test --prefix ${HOME}`,
        resolvedCommand: `npm test --prefix ${HOME}`,
        edits: [`${HOME}/src/app.ts`],
      }),
      3,
    );

    expect(prompt).not.toContain(STAND_IN);
    expect(prompt).toContain("npm test --prefix ~/work/api");
    expect(prompt).toContain("~/work/api/src/app.ts");
  });

  it("given a completed task whose steps name the machine, when the prompt is built, then those fields are masked as well", () => {
    const prompt = buildDistillPrompt(
      candidate({
        task: { goal: `set up ${HOME}`, steps: [`cd ${HOME}`, "run the installer"], verification: `ls ${HOME}` },
      }),
      1,
    );

    expect(prompt).not.toContain(STAND_IN);
    expect(prompt).toContain("cd ~/work/api");
  });
});

describe("assembleSkillMd", () => {
  it("produces spec-compliant team-scope frontmatter unchanged", () => {
    const draft = parseDistillResponse(validResponse)!;
    const md = assembleSkillMd(draft, "team");
    expect(md.startsWith("---\nname: fix-flaky-npm-test\n")).toBe(true);
    expect(md).toContain('description: "Use when npm test fails with a stale snapshot."');
    expect(md).toContain('scope: "team"');
    expect(md).toContain("## Grounded case");
    expect(md).not.toContain("Applies ONLY");
    expect(parseSkillFrontmatter(md)).toEqual({
      name: "fix-flaky-npm-test",
      description: "Use when npm test fails with a stale snapshot.",
      scope: "team",
    });
  });

  it("bakes a project-scope boundary into the description and body (v1 scope guard)", () => {
    const draft = parseDistillResponse(validResponse)!;
    const md = assembleSkillMd(draft, "gitlab.x.com/ekip/bff");
    expect(md).toContain("Applies ONLY in the gitlab.x.com/ekip/bff repository");
    expect(md).toContain("**Scope: only the `gitlab.x.com/ekip/bff` repository.**");
    expect(parseSkillFrontmatter(md)?.scope).toBe("gitlab.x.com/ekip/bff");
  });

  it.each([
    ["the dash the product writes today", "-"],
    ["the dash the product used to write", "\u2014"],
  ])(
    "given a description that already carries the scope sentence with %s, when it is assembled, then the sentence is there once",
    (_label, dash) => {
      // It arrives carrying one because the descriptions the model is shown have it: the
      // model writes in the shape it is given, and the product used to append a second
      // copy, which the length cap then cut in half.
      const draft = {
        ...parseDistillResponse(validResponse)!,
        description: `Use when npm test fails. Applies ONLY in the gitlab.x.com/ekip/bff repository ${dash} do not use it elsewhere.`,
      };

      const md = assembleSkillMd(draft, "gitlab.x.com/ekip/bff");

      expect(md.match(/Applies ONLY in the/g)).toHaveLength(1);
      expect(parseSkillFrontmatter(md)?.description).toBe(
        "Use when npm test fails. Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use it elsewhere.",
      );
    },
  );

  it("given a description that continues after the scope sentence, when it is assembled, then what the author wrote after it survives", () => {
    // The prompt asks the description to state the trigger situation, so text after the
    // sentence is content the product itself asked for.
    const draft = {
      ...parseDistillResponse(validResponse)!,
      description:
        "Use rg not grep. Applies ONLY in the alpha repository - do not use it elsewhere. Trigger: when searching a large tree.",
    };

    const md = assembleSkillMd(draft, "gitlab.x.com/ekip/bff");

    expect(parseSkillFrontmatter(md)?.description).toBe(
      "Use rg not grep. Trigger: when searching a large tree. Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use it elsewhere.",
    );
  });

  it.each([
    ["cut inside the closing clause", "Applies ONLY in the alpha repository - do not use it el"],
    ["cut inside the word repository", "Applies ONLY in the alpha reposi"],
    ["cut right after the repository name", "Applies ONLY in the alpha"],
    ["cut before the repository name", "Applies ONLY in the"],
  ])(
    "given a copy the length cap cut short, %s, when it is assembled, then the sentence is there once",
    (_label, tail) => {
      const draft = { ...parseDistillResponse(validResponse)!, description: `Use rg not grep. ${tail}` };

      const md = assembleSkillMd(draft, "gitlab.x.com/ekip/bff");

      expect(md.match(/Applies ONLY in the/g)).toHaveLength(1);
      expect(parseSkillFrontmatter(md)?.description).toBe(
        "Use rg not grep. Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use it elsewhere.",
      );
    },
  );

  it.each([
    [
      "the closing clause is not the one the product writes",
      "Use when X. Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use. And more.",
    ],
    [
      "there is no closing clause at all",
      "Use when X. Applies ONLY in the gitlab.x.com/ekip/bff repository. And more.",
    ],
  ])(
    "given a copy whose wording drifted, %s, when it is assembled, then the whole sentence goes and nothing of it is left mid-text",
    (_label, description) => {
      // Matching the closing clause word for word left the drifted half standing in the
      // middle of the description, which reads as something the author meant.
      const draft = { ...parseDistillResponse(validResponse)!, description };

      const md = assembleSkillMd(draft, "gitlab.x.com/ekip/bff");

      expect(parseSkillFrontmatter(md)?.description).toBe(
        "Use when X. And more. Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use it elsewhere.",
      );
    },
  );

  it.each([
    ["a project scope, where a fresh sentence is appended", "gitlab.x.com/ekip/bff"],
    ["team scope, where none is", "team"],
  ])(
    "given a description that is nothing but the scope sentence, under %s, when it is assembled, then nothing opens with a stray space",
    (_label, scope) => {
      // The space used to live at the front of the appended sentence, so an empty left-hand
      // side put it at the front of the description - and a quoted YAML scalar keeps it.
      const draft = {
        ...parseDistillResponse(validResponse)!,
        description: "Applies ONLY in the a/b repository - do not use it elsewhere.",
      };

      const description = parseSkillFrontmatter(assembleSkillMd(draft, scope))?.description ?? "";

      expect(description).toBe(description.trim());
    },
  );

  it("given the sentence standing first, when it is assembled, then the description does not open with the space it left behind", () => {
    const draft = {
      ...parseDistillResponse(validResponse)!,
      description: "Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use it elsewhere. Use when Y.",
    };

    const md = assembleSkillMd(draft, "gitlab.x.com/ekip/bff");

    expect(parseSkillFrontmatter(md)?.description).toBe(
      "Use when Y. Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use it elsewhere.",
    );
  });

  it("given a repository name with dots in it, when it is assembled, then the sentence is still taken off whole", () => {
    // The pattern stops at the first sentence end, and a forge scope carries dots of its
    // own: if the repository name were not matched as one run, the stop would land inside
    // it and half the sentence would stay.
    const draft = {
      ...parseDistillResponse(validResponse)!,
      description: "Use when X. Applies ONLY in the gitlab.x.com/a/b repository - do not use it elsewhere. And more.",
    };

    const md = assembleSkillMd(draft, "team");

    expect(parseSkillFrontmatter(md)?.description).toBe("Use when X. And more.");
  });

  it("given the author's own words inside that same sentence, when it is assembled, then they go with it - the accepted cost", () => {
    // Written down as a test because it is a trade, not an oversight: the stop is a
    // sentence end rather than a spelling, so anything standing between the opening words
    // and the first full stop goes. Narrowing the pattern would bring back the half-removed
    // copy this replaced, and this case is what would pay for it.
    const draft = {
      ...parseDistillResponse(validResponse)!,
      description: "Use when X. Applies ONLY in the a/b repository, and also when Y. Trigger: Z.",
    };

    const md = assembleSkillMd(draft, "team");

    expect(parseSkillFrontmatter(md)?.description).toBe("Use when X. Trigger: Z.");
  });

  it("given a description that merely begins like the sentence and then goes on, when it is assembled, then its own words are kept", () => {
    const draft = {
      ...parseDistillResponse(validResponse)!,
      description: "Use rg not grep. Applies ONLY in the first pass over a large tree.",
    };

    const md = assembleSkillMd(draft, "team");

    expect(parseSkillFrontmatter(md)?.description).toBe(
      "Use rg not grep. Applies ONLY in the first pass over a large tree.",
    );
  });

  it("given a team-scope skill whose description claims a repository boundary, when it is assembled, then the claim is taken off", () => {
    const draft = {
      ...parseDistillResponse(validResponse)!,
      description: "Use when npm test fails. Applies ONLY in the gitlab.x.com/ekip/bff repository - do not use it elsewhere.",
    };

    const md = assembleSkillMd(draft, "team");

    expect(md).not.toContain("Applies ONLY");
    expect(parseSkillFrontmatter(md)?.description).toBe("Use when npm test fails.");
  });

  it("escapes quotes in the description", () => {
    const draft = { ...parseDistillResponse(validResponse)!, description: 'needs "camelCase" keys' };
    expect(assembleSkillMd(draft, "team")).toContain('description: "needs \\"camelCase\\" keys"');
  });

  it("neutralizes a newline in a scalar so it cannot inject a frontmatter field", () => {
    const draft = { ...parseDistillResponse(validResponse)!, description: "line one\nname: hijacked" };
    const md = assembleSkillMd(draft, "team");
    // the injected "name:" line stays inside the quoted description scalar
    expect(md).toContain('description: "line one\\nname: hijacked"');
    // so the real name survives the line-based frontmatter parser
    expect(parseSkillFrontmatter(md)?.name).toBe("fix-flaky-npm-test");
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

  it.each([
    ["a whole one", "Applies ONLY in the a/b repository - do not use it elsewhere."],
    ["one the length cap cut short", "Applies ONLY in the a/b reposi"],
  ])(
    "given a description that is nothing but the scope sentence, %s, when it is distilled, then the candidate is dropped rather than written with an empty one",
    async (_label, description) => {
      // Assembly owns that sentence and takes it back off, so what is left describes
      // nothing - and a skill whose frontmatter describes nothing is one Claude Code never
      // loads. The parse asks for a description that is not empty; this asks for one that
      // is still not empty afterwards.
      const reply = JSON.stringify({ ...JSON.parse(validResponse), description });

      const outcome = await distillVerdict(promoted(), 1, defaultDistillConfig, async () => reply, () => null);

      expect(outcome).toMatchObject({ outcome: "error", error: "description was only the scope sentence" });
    },
  );
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
