import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { OrchestratorContext } from "../app.js";
import type { Principal } from "../auth.js";
import { openSqliteStore } from "../store.js";
import { startersFor, StartersRefused } from "./starters.js";

const OWNER: Principal = { id: "u-solo", name: "Solo Person", email: "solo@example.invalid", role: "owner", ownedTeams: [] };

/** A home with one project folder of the person's, written as the test says, and its orchestrator. */
async function project(files: Record<string, string>) {
  const home = mkdtempSync(join(tmpdir(), "starters-home-"));
  const folder = join(home, "work", "shop");
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(folder, path, ".."), { recursive: true });
    writeFileSync(join(folder, path), text);
  }
  const ctx: OrchestratorContext = { store: openSqliteStore(":memory:"), dataDir: join(home, "data"), tenant: "default" };
  await ctx.store.upsertRepo({ tenant: "default", id: "shop", team: "Mine", name: "shop", url: folder });
  return { ctx, home };
}

describe("tasks to start a project with, read off its folder", () => {
  it("given a folder with notes in its code, in its dependencies and in a hidden folder, and a manifest with test and lint scripts, when the starters are read, then they are its own notes in file order, each where it is, then the checks, and nothing runs", async () => {
    // given
    const { ctx, home } = await project({
      "src/cart.ts": "export const total = 0;\n// TODO: handle an empty cart\n",
      "src/price.py": "def price():\n    pass  # FIXME rounding goes the wrong way\n",
      "node_modules/lib/index.js": "// TODO: not ours\n",
      ".cache/old.ts": "// TODO: hidden\n",
      "README.md": "TODO: not code\n",
      "package.json": JSON.stringify({ scripts: { test: "vitest run", lint: "eslint ." } }),
    });

    // when
    const starters = await startersFor(ctx, OWNER, "shop", home);

    // then
    expect(starters.map((s) => [s.kind, s.title, s.where])).toEqual([
      ["todo", "Resolve the TODO in src/cart.ts:2", "src/cart.ts:2"],
      ["todo", "Resolve the FIXME in src/price.py:2", "src/price.py:2"],
      ["tests", "Run the tests and fix the first one that fails", "package.json"],
      ["lint", "Run the linter and fix what it reports", "package.json"],
    ]);
    expect(starters[0]!.description).toBe("Resolve the TODO note in src/cart.ts:2. The note there says, quoted from the file:\n> handle an empty cart");
  });

  it("given a note that reads like a secret, when the starters are read, then the note is withheld", async () => {
    // given
    const { ctx, home } = await project({ "src/deploy.ts": `// TODO use ghp_${"a".repeat(36)} until the vault\n` });

    // when
    const [starter] = await startersFor(ctx, OWNER, "shop", home);

    // then
    expect(starter!.description).toBe("Resolve the TODO note in src/deploy.ts:1. The note there says, quoted from the file:\n> [withheld]");
  });

  it("given an unknown project or a person who does not start tasks on its team, when the starters are read, then it is refused as unknown", async () => {
    // given
    const { ctx, home } = await project({ "src/a.ts": "// TODO: x\n" });
    await ctx.store.upsertRepo({ tenant: "default", id: "theirs", team: "Payments", name: "theirs", url: join(home, "work", "shop") });
    const member: Principal = { id: "u-m", name: "Mel", email: "mel@example.invalid", role: "viewer", ownedTeams: [] };

    // then
    await expect(startersFor(ctx, OWNER, "nowhere", home)).rejects.toBeInstanceOf(StartersRefused);
    await expect(startersFor(ctx, member, "theirs", home)).rejects.toBeInstanceOf(StartersRefused);
  });

  it("given a project whose folder holds thousands of data files before its code, when the starters are read, then the walk stops at its bound and reads no note past it", async () => {
    // given
    const data = Object.fromEntries(Array.from({ length: 5_001 }, (_, i) => [`a-data/row-${String(i).padStart(5, "0")}.csv`, ""]));
    const { ctx, home } = await project({ ...data, "z-src/late.ts": "// TODO: past the bound\n" });

    // when
    const starters = await startersFor(ctx, OWNER, "shop", home);

    // then
    expect(starters).toEqual([]);
  });
});

