import { readdirSync, readFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// plugin.ts is the orchestrator's only door into the plugin's src/lib, because several of those
// modules default their state to the account's home. Every other orchestrator file must go
// through it, and plugin.ts itself may name only modules whose exported functions take
// their inputs as arguments.
// branch: assignmentRecordProblem only, the plugin's own rule for a reviewer or label. It
// takes the lists as arguments; the module reads a team file only in functions given its
// directory, and nothing in it or its imports reaches a home directory at import time.
// skill-format and skill-health: checkSkillFormat and overlappingSkills take the text they
// judge as arguments; skill-health reaches a home directory only in functions that default
// a parameter to it, and the import below is measured with homedir() throwing.
// policy: the orchestrator reads the team file's grammar and matching from it; the machine's own
// policy (teamPolicy, the last-good cache) reaches a home only through defaulted parameters,
// measured the same way below.
// share and queue: the Team handbook lists the person's own skills, servers and commands with
// /handbook:share's buildInventory and screens a skill with auditSkillDir, so it holds to the same
// share rules as the plugin. buildInventory reads a home only through its defaulted paths, which
// the orchestrator passes on a one-person orchestrator alone; both modules load with homedir()
// throwing, measured below.
const ALLOWED = new Set(["skill-index", "mcp", "secrets", "init", "upgrade", "branch", "join", "commands", "skill-format", "skill-health", "policy", "task-lesson", "share", "queue"]);

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.(ts|tsx)$/.test(entry.name) && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("the orchestrator's imports from the plugin", () => {
  it("given every orchestrator source, when its imports are read, then only plugin.ts reaches src/lib and only into the allowed modules", () => {
    // given
    const root = join(import.meta.dirname, "..");
    const files = ["server", "demo", "web/src"].flatMap((d) => sources(join(root, d)));

    // when
    const reaches = files.flatMap((file) =>
      [...readFileSync(file, "utf8").matchAll(/from\s+"([^"]*src\/lib\/([^"/]+?)(?:\.js)?)"/g)].map((m) => ({
        file: file.slice(root.length + 1),
        module: m[2]!,
      })),
    );

    // then
    expect(reaches.length).toBeGreaterThan(0);
    expect(reaches.filter((r) => r.file !== join("server", "plugin.ts"))).toEqual([]);
    expect(reaches.filter((r) => !ALLOWED.has(r.module))).toEqual([]);
  });

  it("given homedir() made to throw, when the plugin modules the orchestrator reads skills and policies with are imported, then they load and nothing asked for a home directory", async () => {
    // given
    const real = os.homedir;
    os.homedir = () => {
      throw new Error("a home directory was asked for at import time");
    };
    syncBuiltinESMExports();

    try {
      // when
      const loaded = await Promise.all([import("../../src/lib/skill-format.js"), import("../../src/lib/skill-health.js"), import("../../src/lib/policy.js"), import("../../src/lib/task-lesson.js"), import("../../src/lib/share.js"), import("../../src/lib/queue.js")]);

      // then
      expect(typeof loaded[0].checkSkillFormat).toBe("function");
      expect(typeof loaded[1].overlappingSkills).toBe("function");
      expect(typeof loaded[3].queueTaskLesson).toBe("function");
      expect(typeof loaded[4].buildInventory).toBe("function");
      expect(typeof loaded[5].auditSkillDir).toBe("function");
      expect(loaded[2].policiesProblem([{ id: "pol_x", name: "x", rules: [{ action: "mcp.use", resource: "mcp:x", effect: "deny", reason: "x" }] }])).toBeNull();
    } finally {
      os.homedir = real;
      syncBuiltinESMExports();
    }
  });
});
