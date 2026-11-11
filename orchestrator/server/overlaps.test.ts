import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { skillOverlaps } from "./overlaps.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function mirror(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-overlaps-"));
  dirs.push(dir);
  return join(dir, "repo.git");
}

const same = (count: number, words = 140) => {
  const description = Array.from({ length: words }, (_, k) => `subject${k}term`).join(" ");
  return Array.from({ length: count }, (_, i) => ({ slug: `skill-${String(i).padStart(4, "0")}`, description }));
};

describe("which skills answer the same requests", () => {
  it("given one head asked for twice and then a new head, when the overlaps are worked out, then the skills are read once for each head", async () => {
    // given
    const repo = mirror();
    let reads = 0;
    const skills = async () => {
      reads++;
      return same(3);
    };

    // when
    await skillOverlaps(repo, "a".repeat(40), skills);
    await skillOverlaps(repo, "a".repeat(40), skills);
    const moved = await skillOverlaps(repo, "b".repeat(40), skills);

    // then
    expect(reads).toBe(2);
    expect(moved["skill-0000"]).toEqual({ names: ["skill-0001", "skill-0002"], more: 0 });
  });

  it("given thousands of skills that all say the same thing, when the overlaps are worked out, then other work runs before the answer is ready and each skill names at most ten", async () => {
    // given
    const repo = mirror();
    let settled = false;
    let ranMeanwhile = false;

    // when
    const answer = skillOverlaps(repo, "c".repeat(40), async () => same(1500)).finally(() => (settled = true));
    const other = new Promise<void>((resolve) => setTimeout(() => {
      ranMeanwhile = !settled;
      resolve();
    }, 20));
    const [found] = await Promise.all([answer, other]);

    // then
    expect(ranMeanwhile).toBe(true);
    expect(found["skill-0000"]!.names).toHaveLength(10);
    expect(found["skill-0000"]!.more).toBe(1489);
  });
});
