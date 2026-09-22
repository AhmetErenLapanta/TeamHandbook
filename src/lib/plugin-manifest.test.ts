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
// a path that no longer exists breaks every install while the whole unit suite stays
// green. Paths here are DERIVED from the manifests and from the source that resolves
// them, never listed, so the check cannot go stale when a manifest grows a hook.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Claude Code substitutes the installed plugin directory for CLAUDE_PLUGIN_ROOT before
// running a command, and the shell expands either form. Both are accepted on purpose: a
// contributor who writes the brace-less form produces a command that RUNS, and a test
// that reds a working repo is worse than one that misses, now that the CI badge is
// public. The `${?...}?` shorthand is deliberately NOT used - it would also accept
// "${CLAUDE_PLUGIN_ROOT/..." , which is malformed and would expand to the wrong thing.
const PLUGIN_ROOT_REF = /(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)\/([A-Za-z0-9._/-]+)/g;

// Claude Code's hook events, NOT the ones this manifest happens to use: deriving the set
// from hooks.json would make it agree with any typo hooks.json contains, which is the
// whole failure this guards. Deliberately wider than what the plugin declares today,
// because a set that is too narrow reds a working repo while one that is too wide only
// misses a rename. Widening it is a decision, and the failure message prints the set so
// a contributor adding a real event knows what to edit instead of guessing.
const CLAUDE_CODE_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "PreCompact",
  "SessionStart",
  "SessionEnd",
]);

// demo.md runs no engine binary on purpose: it builds a scratch project and hands the
// work to a clean session, because a session that narrates itself harvests badly. Naming
// the exemption is what lets every OTHER command file carry a per-file assertion, which
// is what catches one silently losing its only reference.
const COMMANDS_WITHOUT_ENGINE = new Set(["demo.md"]);

// run-pipeline is spawned from inside a hook bundle and is never typed by a user, so it
// is the one entrypoint allowed to have no command markdown.
const CLI_WITHOUT_COMMAND = new Set(["run-pipeline"]);

// Not every shipped bundle is named in a manifest. run-pipeline.js is resolved at runtime
// from the calling bundle's own location, so a build that stops emitting it breaks the
// harvest with no symptom but silence. The references are derived from the source that
// resolves them rather than listed here.
const SIBLING_BUNDLE = /new URL\(\s*"\.\/([A-Za-z0-9._-]+\.js)"\s*,\s*import\.meta\.url\s*\)/g;

function pluginRootPaths(text: string): string[] {
  return [...text.matchAll(PLUGIN_ROOT_REF)].map((match) => match[1]!);
}

interface HookEntry {
  type?: string;
  command?: string;
}

function readHooksManifest(): Record<string, { hooks?: HookEntry[] }[]> {
  return JSON.parse(readFileSync(join(repoRoot, "hooks", "hooks.json"), "utf8")).hooks;
}

function declaredCommands(event: string): string[] {
  const entries = readHooksManifest()[event] ?? [];
  return entries.flatMap((entry) => (entry.hooks ?? []).map((hook) => hook.command ?? ""));
}

function entrypointNames(dir: string): string[] {
  return readdirSync(join(repoRoot, dir))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => name.replace(/\.ts$/, ""));
}

describe("hooks/hooks.json", () => {
  it("declares known events, and a resolvable file in every command under them", () => {
    // given the root manifest Claude Code reads when the plugin is installed
    const manifest = readHooksManifest();
    const events = Object.entries(manifest);

    // when each event and each command beneath it is resolved the way the runtime
    // resolves them
    expect(events.length).toBeGreaterThan(0);
    for (const [event, entries] of events) {
      // then the event name is one Claude Code actually fires. A valid path under a
      // misspelled event installs cleanly and never runs.
      expect(
        CLAUDE_CODE_HOOK_EVENTS.has(event),
        `unknown hook event "${event}" - Claude Code fires: ${[...CLAUDE_CODE_HOOK_EVENTS].join(", ")}`,
      ).toBe(true);

      const hooks = entries.flatMap((entry) => entry.hooks ?? []);
      expect(hooks.length, `event "${event}" declares no hooks`).toBeGreaterThan(0);
      for (const hook of hooks) {
        expect(hook.type, `unsupported hook type under "${event}"`).toBe("command");
        const paths = pluginRootPaths(hook.command ?? "");
        // A command naming no path is a failure, not a skip: that is how this test would
        // silently stop measuring anything if the manifest were ever restructured.
        expect(paths, `no CLAUDE_PLUGIN_ROOT path in: ${hook.command}`).not.toHaveLength(0);
        for (const path of paths) {
          expect(existsSync(join(repoRoot, path)), `missing file referenced by hooks.json: ${path}`).toBe(true);
        }
      }
    }
  });
});

describe("commands/*.md", () => {
  it("reaches the engine from every command file, at a path that exists", () => {
    // given the command markdown the plugin ships
    const dir = join(repoRoot, "commands");
    const files = readdirSync(dir).filter((name) => name.endsWith(".md"));

    // when each file's plugin-root references are resolved on their own
    expect(files.length).toBeGreaterThan(0);
    for (const name of files) {
      const referenced = pluginRootPaths(readFileSync(join(dir, name), "utf8"));

      // then the file still reaches the engine, unless it is one of the named
      // exemptions, and every path it does name exists. Asserted per file rather than
      // over the whole set: a set-level count stays satisfied by the other 20
      // references while one command quietly loses its only one and stops working.
      if (!COMMANDS_WITHOUT_ENGINE.has(name)) {
        expect(referenced, `commands/${name} no longer runs anything`).not.toHaveLength(0);
      }
      for (const path of referenced) {
        expect(existsSync(join(repoRoot, path)), `missing file referenced by commands/${name}: ${path}`).toBe(true);
      }
    }
  });

  it("has a command markdown for every CLI entrypoint a user is meant to reach", () => {
    // given the entrypoints the engine ships and the command files that invoke them
    const cli = entrypointNames("src/cli");
    const commands = readdirSync(join(repoRoot, "commands"))
      .filter((name) => name.endsWith(".md"))
      .map((name) => name.replace(/\.md$/, ""));

    // when each entrypoint is looked for among the commands. A command file deleted
    // outright cannot be caught by iterating the directory it was deleted from, which
    // is why this sits beside the per-file check rather than replacing it.
    expect(cli.length).toBeGreaterThan(0);
    expect(commands.length).toBeGreaterThan(0);

    // then every entrypoint still has one. Deliberately checked in this direction only:
    // an entrypoint with no command is unreachable, but a command file need not be named
    // after an entrypoint (one that aliases another command's binary is legitimate), and
    // an entrypoint that disappears already fails the per-file check above when its
    // bundle stops being built.
    for (const name of cli) {
      if (CLI_WITHOUT_COMMAND.has(name)) continue;
      expect(commands, `src/cli/${name}.ts has no commands/${name}.md to reach it`).toContain(name);
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
      // checked before statSync, which would otherwise throw a bare ENOENT and leave
      // the reader to work out what the manifest said
      expect(existsSync(dir), `plugin source does not exist: ${dir}`).toBe(true);
      expect(statSync(dir).isDirectory(), `plugin source is not a directory: ${dir}`).toBe(true);
      const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf8"));
      expect(manifest.name).toBe(name);
    }
    expect(plugin.name).toBe(marketplace.plugins[0].name);
  });
});

describe("bundles resolved from code rather than from a manifest", () => {
  it("ships every sibling bundle a hook resolves at runtime", () => {
    // given the entrypoints that can spawn a sibling bundle by its own location
    const files = ["src/hooks", "src/cli"].flatMap((dir) =>
      entrypointNames(dir).map((name) => ({ label: `${dir}/${name}.ts`, text: readFileSync(join(repoRoot, dir, `${name}.ts`), "utf8") })),
    );

    // when the sibling references are read out of the source that resolves them
    const referenced: { label: string; bundle: string }[] = [];
    for (const { label, text } of files) {
      const matches = [...text.matchAll(SIBLING_BUNDLE)];
      referenced.push(...matches.map((match) => ({ label, bundle: match[1]! })));
      // Every import.meta.url in these entrypoints must be one this pattern understands.
      // A form it does not recognize (a parent directory, a computed name) maps to a
      // different bundle, and skipping it silently is the vacuous pass this file exists
      // to rule out.
      const total = [...text.matchAll(/import\.meta\.url/g)].length;
      expect(matches.length, `unrecognized import.meta.url reference in ${label}`).toBe(total);
    }

    // then each one exists in the published tree. Nothing names these in a manifest, so
    // a build that stops emitting one fails silently at runtime and nowhere else.
    expect(referenced.length).toBeGreaterThan(0);
    for (const { label, bundle } of referenced) {
      expect(existsSync(join(repoRoot, "dist", bundle)), `${label} resolves dist/${bundle}, which is not shipped`).toBe(
        true,
      );
    }
  });
});

describe("skills/", () => {
  it("gives every shipped skill directory the SKILL.md that makes it discoverable", () => {
    // given the skills the plugin ships, found by the same convention Claude Code uses
    const root = join(repoRoot, "skills");
    const dirs = readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory());

    // when each is checked for its manifest file
    expect(dirs.length).toBeGreaterThan(0);

    // then it is there: a skill directory without one is invisible, with no error
    for (const dir of dirs) {
      expect(existsSync(join(root, dir.name, "SKILL.md")), `skills/${dir.name} has no SKILL.md`).toBe(true);
    }
  });
});

describe("the declared PostToolUseFailure hook, actually executed", () => {
  it("records the failed command under an isolated handbook home", () => {
    // given the command strings the manifest declares, run through a shell exactly as
    // Claude Code runs them. PostToolUseFailure is the cheapest representative choice:
    // it shells out to nothing, spawns no pipeline and makes no model call, yet it is
    // the entry point of the whole evidence path.
    const commands = declaredCommands("PostToolUseFailure");
    expect(commands.length).toBeGreaterThan(0);
    const payload = JSON.stringify({
      session_id: "k50-install-smoke",
      cwd: "/repo",
      hook_event_name: "PostToolUseFailure",
      tool_name: "Bash",
      tool_input: { command: "npm test" },
      error: "Exit code 1\ntest failed",
      is_interrupt: false,
    });

    for (const command of commands) {
      const home = mkdtempSync(join(tmpdir(), "handbook-smoke-home-"));
      const fakeHome = mkdtempSync(join(tmpdir(), "handbook-smoke-os-"));
      try {
        // when a real failed-Bash event is piped into it
        execFileSync("sh", ["-c", command], {
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
        expect(state.openErrors, `no evidence written by: ${command}`).toHaveLength(1);
        expect(state.openErrors[0]).toMatchObject({ family: "npm test", command: "npm test", cwd: "/repo" });
      } finally {
        // never let a cleanup error stand in for the assertion that actually failed
        try {
          rmSync(home, { recursive: true, force: true });
          rmSync(fakeHome, { recursive: true, force: true });
        } catch {
          // a leftover temp dir is not worth masking the real failure
        }
      }
    }
  });
});
