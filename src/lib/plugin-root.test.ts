import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pluginVersion } from "./plugin-root.js";

let roots: string[] = [];

afterEach(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true });
  roots = [];
});

/** An installed copy: its manifest and the package.json beside it. */
function copyWith(manifest: Record<string, unknown>, pkg?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "handbook-copy-"));
  roots.push(root);
  mkdirSync(join(root, ".claude-plugin"));
  writeFileSync(join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest));
  if (pkg) writeFileSync(join(root, "package.json"), JSON.stringify(pkg));
  return root;
}

describe("pluginVersion", () => {
  it("given a manifest carrying a version, when the version is read, then that is the answer", () => {
    // given
    const root = copyWith({ name: "teamhandbook", version: "0.30.0" }, { version: "0.29.0" });

    // when
    const version = pluginVersion(root);

    // then
    expect(version).toBe("0.30.0");
  });

  it("given a manifest without a version line, when the version is read, then the release in package.json is the answer", () => {
    // given
    const root = copyWith({ name: "teamhandbook" }, { version: "0.30.0" });

    // when
    const version = pluginVersion(root);

    // then the old reading printed "vunknown" here
    expect(version).toBe("0.30.0");
  });

  it("given neither file carries a version, when the version is read, then it says unknown rather than guessing", () => {
    // given
    const root = copyWith({ name: "teamhandbook" });

    // when
    const version = pluginVersion(root);

    // then
    expect(version).toBe("unknown");
  });
});

describe("the shipped bundles and the root they read", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

  it.each(["status.js", "doctor.js"])(
    "given %s installed under a root carrying its own version, when it runs, then its header names that version",
    (bundle) => {
      // given the bundle where Claude Code puts it: <root>/dist, beside that root's manifest
      const root = copyWith({ name: "teamhandbook", version: "7.7.7" }, { version: "7.7.7", type: "module" });
      mkdirSync(join(root, "dist"));
      copyFileSync(join(repoRoot, "dist", bundle), join(root, "dist", bundle));
      const home = mkdtempSync(join(tmpdir(), "handbook-home-"));
      roots.push(home);
      // An empty PATH and none of the parent's environment: the doctor probes `claude -p`, and
      // node's own directory on PATH is where the real claude is installed beside it, so the
      // probe reached the developer's signed-in CLI and its keys.
      const noTools = mkdtempSync(join(tmpdir(), "handbook-path-"));
      roots.push(noTools);

      // when
      let out: string;
      try {
        out = execFileSync(process.execPath, [join(root, "dist", bundle)], {
          encoding: "utf8",
          env: { HOME: home, TEAMHANDBOOK_HOME: home, PATH: noTools },
        });
      } catch (err) {
        out = String((err as { stdout?: unknown }).stdout ?? "");
      }

      // then the default root is the bundle's own, not the repository the test runs in
      expect(out.split("\n")[0]).toContain("(v7.7.7");
    },
  );
});

