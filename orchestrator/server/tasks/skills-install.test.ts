import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Every writeFile the install makes is counted while it is in flight.
const counter = vi.hoisted(() => ({ now: 0, most: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const real = await original<typeof import("node:fs/promises")>();
  return {
    ...real,
    writeFile: async (...args: Parameters<typeof real.writeFile>) => {
      counter.now++;
      counter.most = Math.max(counter.most, counter.now);
      try {
        await new Promise((r) => setTimeout(r, 1));
        return await real.writeFile(...args);
      } finally {
        counter.now--;
      }
    },
  };
});

const { fakeAgentAdapter, SKILL_WRITES_AT_ONCE } = await import("./agents.js");
const { makeTaskDirs, taskPaths } = await import("./isolation.js");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("installing a team's skills for an agent", () => {
  it("given a team with hundreds of skill files, when they are installed, then every file is written whole and no more than the limit are open at once", async () => {
    // given
    const root = mkdtempSync(join(tmpdir(), "orchestrator-install-"));
    dirs.push(root);
    const paths = taskPaths(root, "t", "0123456789ab");
    await makeTaskDirs(paths);
    const skills = Array.from({ length: 300 }, (_, i) => ({
      slug: `s${i}`,
      files: [
        { path: "SKILL.md", content: `---\nname: s${i}\ndescription: Use for ${i}.\n---\n` },
        { path: "refs/notes.md", content: `notes ${i}\n` },
      ],
    }));

    // when
    await fakeAgentAdapter("fake-agent.mjs").configure(paths, { skills, mcpServers: {}, mcpTools: [] });

    // then
    for (const i of [0, 149, 299]) {
      expect(readFileSync(join(paths.home, "skills", `s${i}`, "SKILL.md"), "utf8")).toBe(`---\nname: s${i}\ndescription: Use for ${i}.\n---\n`);
      expect(readFileSync(join(paths.home, "skills", `s${i}`, "refs", "notes.md"), "utf8")).toBe(`notes ${i}\n`);
    }
    expect(counter.most).toBeGreaterThan(1);
    expect(counter.most).toBeLessThanOrEqual(SKILL_WRITES_AT_ONCE);
  });
});
