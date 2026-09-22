import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSessionState } from "./session-state.js";

// Every other test in this repo calls a lib function directly, so nothing measures the
// layer a user meets first: the plugin manifests Claude Code reads at install time. A
// renamed entrypoint, a file missing from the published tree, or a manifest pointing at
// a path that no longer exists breaks every install while all 860 unit tests stay green.
// Paths here are DERIVED from the manifests, never listed, so the check cannot go stale
// when a manifest grows a hook or a command.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Claude Code substitutes ${CLAUDE_PLUGIN_ROOT} with the installed plugin directory, so
// a literal string match on the path would miss what actually gets executed.
const PLUGIN_ROOT_REF = /\$\{CLAUDE_PLUGIN_ROOT\}\/([A-Za-z0-9._/-]+)/g;

function pluginRootPaths(text: string): string[] {
  return [...text.matchAll(PLUGIN_ROOT_REF)].map((match) => match[1]!);
}

interface HookEntry {
  type?: string;
  command?: string;
}

function readHooksManifest(): Record<string, { hooks?: HookEntry[] }[]> {
  const raw = readFileSync(join(repoRoot, "hooks", "hooks.json"), "utf8");
  return JSON.parse(raw).hooks;
}

function declaredCommands(event: string): string[] {
  const entries = readHooksManifest()[event] ?? [];
  return entries.flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ""));
}

describe("hooks/hooks.json", () => {
  it("names a resolvable file in every command it declares", () => {
    // given the root manifest Claude Code reads when the plugin is installed
    const manifest = readHooksManifest();
    const commands = Object.values(manifest).flatMap((entries) =>
      entries.flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? "")),
    );

    // when every command string is resolved the way the runtime resolves it
    const resolved = commands.map((command) => ({ command, paths: pluginRootPaths(command) }));

    // then the manifest declares hooks at all, each command names a path, and each path
    // exists. A command yielding no path is a failure, not a skip: that is how this test
    // would silently stop measuring anything if the manifest were ever restructured.
    expect(resolved.length).toBeGreaterThan(0);
    for (const { command, paths } of resolved) {
      expect(paths, `no \${CLAUDE_PLUGIN_ROOT} path in: ${command}`).not.toHaveLength(0);
      for (const path of paths) {
        expect(existsSync(join(repoRoot, path)), `missing file referenced by hooks.json: ${path}`).toBe(true);
      }
    }
  });
});

describe("commands/*.md", () => {
  it("names a resolvable file in every plugin-root reference", () => {
    // given the command markdown the plugin ships
    const dir = join(repoRoot, "commands");
    const files = readdirSync(dir).filter((name) => name.endsWith(".md"));

    // when each file's plugin-root references are collected
    const referenced = files.flatMap((name) => pluginRootPaths(readFileSync(join(dir, name), "utf8")));

    // then there are commands, they reference the engine, and every referenced file
    // exists. The assertion is over the whole set rather than per file, because demo.md
    // legitimately runs no engine binary.
    expect(files.length).toBeGreaterThan(0);
    expect(referenced.length).toBeGreaterThan(0);
    for (const path of new Set(referenced)) {
      expect(existsSync(join(repoRoot, path)), `missing file referenced by commands/: ${path}`).toBe(true);
    }
  });
});

describe(".claude-plugin manifests", () => {
  it("describes a plugin whose source directory is the one that carries plugin.json", () => {
    // given the two manifests that make this repo installable as a marketplace
    const marketplace = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    const plugin = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"));

    // when each declared plugin source is resolved against the repo
    const sources: { name: string; dir: string }[] = marketplace.plugins.map(
      (entry: { name: string; source: string }) => ({ name: entry.name, dir: join(repoRoot, entry.source) }),
    );

    // then every source is a directory holding its own plugin.json, and the name the
    // marketplace advertises is the name that plugin.json answers to - a mismatch makes
    // `/plugin install <name>@<marketplace>` resolve to nothing.
    expect(sources.length).toBeGreaterThan(0);
    for (const { name, dir } of sources) {
      expect(existsSync(dir), `plugin source does not exist: ${dir}`).toBe(true);
      expect(statSync(dir).isDirectory(), `plugin source is not a directory: ${dir}`).toBe(true);
      const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
      expect(manifest.name).toBe(name);
    }
    expect(plugin.name).toBe(marketplace.plugins[0].name);
  });
});

describe("the declared PostToolUseFailure hook, actually executed", () => {
  it("records the failed command under an isolated handbook home", () => {
    // given the command string the manifest declares, run through a shell exactly as
    // Claude Code runs it, against throwaway directories. PostToolUseFailure is the
    // cheapest representative choice: it shells out to nothing, spawns no pipeline and
    // makes no model call, yet it is the entry point of the whole evidence path.
    const commands = declaredCommands("PostToolUseFailure");
    expect(commands).toHaveLength(1);
    const home = mkdtempSync(join(tmpdir(), "handbook-smoke-home-"));
    const fakeHome = mkdtempSync(join(tmpdir(), "handbook-smoke-os-"));
    const payload = JSON.stringify({
      session_id: "k50-install-smoke",
      cwd: "/repo",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Exit code 1\ntest failed",
      is_interrupt: false,
    });

    try {
      // when a real failed-Bash event is piped into it
      execFileSync("sh", ["-c", commands[0]!], {
        input: payload,
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_PLUGIN_ROOT: repoRoot,
          TEAMHANDBOOK_HOME: home,
          HOME: fakeHome,
          USERPROFILE: fakeHome,
        },
      });

      // then the evidence landed on disk. The entrypoint exits 0 on its own errors by
      // design, so the written state is the only thing that proves it ran.
      const state = loadSessionState("k50-install-smoke", home);
      expect(state.openErrors).toHaveLength(1);
      expect(state.openErrors[0]).toMatchObject({ family: "npm test", command: "npm test", cwd: "/repo" });
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });
});
