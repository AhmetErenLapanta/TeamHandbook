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
//
// Everything below errs towards accepting a manifest it does not recognize. A check that
// reds a working tree costs a contributor their afternoon and shows a red badge on a repo
// that is fine; a check that misses one malformed manifest costs one install. The two are
// not symmetric, and every widening here was measured against the runtime rather than
// guessed.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

// Claude Code substitutes the installed plugin directory for CLAUDE_PLUGIN_ROOT, and both
// shell forms work: measured in the `claude` 2.1.278 binary, whose own matchers for this
// variable accept `$CLAUDE_PLUGIN_ROOT` and `${CLAUDE_PLUGIN_ROOT}` alike. The `${?...}?`
// shorthand is deliberately NOT used - it would also accept "${CLAUDE_PLUGIN_ROOT/...",
// which is malformed and expands to the wrong thing.
const PLUGIN_ROOT_REF = /(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)/;
// The same variable followed by a path, which is the form whose target can be verified.
// A command may also just cd into the root and use a relative path, so the reference
// above is what satisfies the "names something" guard, and this is what gets resolved.
const PLUGIN_ROOT_PATH = /(?:\$\{CLAUDE_PLUGIN_ROOT\}|\$CLAUDE_PLUGIN_ROOT)\/([A-Za-z0-9._/-]+)/g;
// A literal bundle path, which catches the `cd "${CLAUDE_PLUGIN_ROOT}" && node dist/x.js`
// shape that the pattern above cannot resolve on its own.
const BUNDLE_PATH = /\bdist\/[A-Za-z0-9._-]+\.js\b/g;

// The hook events counted in the `claude` 2.1.278 binary's own event list. This is a
// snapshot of another program's runtime and WILL go stale: the version is recorded so a
// reader knows what it was taken from and can retake it. Deliberately far wider than the
// six this plugin declares, because the cost of the two mistakes is not symmetric - a name
// missing from here reds a working hook, while an extra name here only misses a typo.
// `Worktree` is a prefix in that list rather than a single name, so it is matched as one.
const KNOWN_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PostToolBatch",
  "Notification",
  "UserPromptSubmit",
  "UserPromptExpansion",
  "SessionStart",
  "SessionEnd",
  "Stop",
  "StopFailure",
  "SubagentStart",
  "SubagentStop",
  "PreCompact",
  "PostCompact",
  "PreModelSwitch",
  "PostModelSwitch",
  "PermissionRequest",
  "PermissionDenied",
  "Setup",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
  "Elicitation",
  "ElicitationResult",
  "ConfigChange",
  "InstructionsLoaded",
  "DirectoryAdded",
]);
const KNOWN_EVENT_PREFIXES = ["Worktree"];

// Claude Code runs two kinds of hook: a "command" one, which shells out, and a "prompt"
// one, which feeds the model an instruction and carries no command field at all. Both are
// accepted in the 2.1.278 binary and in the official hook schema validator. Only the
// command kind names a path, so only that kind is resolved below.
const HOOK_TYPES = ["command", "prompt"];

// demo.md runs no engine binary on purpose: it builds a scratch project and hands the
// work to a clean session, because a session that narrates itself harvests badly. Naming
// the exemption is what lets every OTHER command file carry a per-file assertion, which
// is what catches one silently losing its only reference.
const COMMANDS_WITHOUT_ENGINE = new Set(["demo.md"]);

// run-pipeline is spawned from inside a hook bundle and is never typed by a user, so it
// is the one entrypoint allowed to have no command markdown. The failure message names
// this set, because the cheapest wrong fix for that failure is inventing a slash command
// nobody asked for.
const CLI_WITHOUT_COMMAND = new Set(["run-pipeline"]);

// Not every shipped bundle is named in a manifest. run-pipeline.js is resolved at runtime
// from the calling bundle's own location, so a build that stops emitting it breaks the
// harvest with no symptom but silence. The references are derived from the source that
// resolves them rather than listed here.
const SIBLING_BUNDLE = /new URL\(\s*"\.\/([A-Za-z0-9._-]+\.js)"\s*,\s*import\.meta\.url\s*\)/g;

// A path written in prose ends up with the sentence's punctuation stuck to it, and a
// documentation-only edit must never red CI over a full stop.
function trimPunctuation(path: string): string {
  return path.replace(/[.,;:!?)\]}'"`]+$/, "");
}

function pluginRootPaths(text: string): string[] {
  const fromVariable = [...text.matchAll(PLUGIN_ROOT_PATH)].map((match) => match[1]!);
  const fromBundle = [...text.matchAll(BUNDLE_PATH)].map((match) => match[0]);
  return [...new Set([...fromVariable, ...fromBundle].map(trimPunctuation))];
}

function knownEvent(event: string): boolean {
  return KNOWN_HOOK_EVENTS.has(event) || KNOWN_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix));
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
  it("declares recognized events, and a resolvable file in every command under them", () => {
    // given the root manifest Claude Code reads when the plugin is installed
    const manifest = readHooksManifest();
    const events = Object.entries(manifest);

    // when each event and each hook beneath it is resolved the way the runtime resolves
    // them
    expect(events.length).toBeGreaterThan(0);
    for (const [event, entries] of events) {
      // then the event name is one this test knows about. The message reports what the
      // test recognizes rather than what the runtime supports: this list is a snapshot of
      // another program and must not tell a contributor their working hook does not exist.
      expect(
        knownEvent(event),
        `hook event "${event}" is not one this test recognizes (measured in Claude Code 2.1.278). ` +
          `If it is real, add it to KNOWN_HOOK_EVENTS: ${[...KNOWN_HOOK_EVENTS].join(", ")}`,
      ).toBe(true);

      const hooks = entries.flatMap((entry) => entry.hooks ?? []);
      expect(hooks.length, `event "${event}" declares no hooks`).toBeGreaterThan(0);
      for (const hook of hooks) {
        expect(HOOK_TYPES, `unsupported hook type under "${event}"`).toContain(hook.type);
        // A prompt hook carries no command, so nothing below applies to it.
        if (hook.type !== "command") continue;

        const command = hook.command ?? "";
        // A command naming nothing is a failure, not a skip: that is how this test would
        // silently stop measuring anything if the manifest were ever restructured. The
        // variable on its own satisfies this - a command may cd into the plugin root
        // rather than interpolate the path.
        expect(PLUGIN_ROOT_REF.test(command), `no CLAUDE_PLUGIN_ROOT reference in: ${command}`).toBe(true);
        for (const path of pluginRootPaths(command)) {
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
      const text = readFileSync(join(dir, name), "utf8");
      const referenced = pluginRootPaths(text);

      // then the file still reaches the engine, unless it is one of the named
      // exemptions, and every path it does name exists. Asserted per file rather than
      // over the whole set: a set-level count stays satisfied by the other 20
      // references while one command quietly loses its only one and stops working.
      if (!COMMANDS_WITHOUT_ENGINE.has(name)) {
        expect(PLUGIN_ROOT_REF.test(text), `commands/${name} no longer runs anything`).toBe(true);
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
    // an entrypoint no command reaches is unreachable, but a command file need not be
    // named after an entrypoint (one that aliases another command's binary is
    // legitimate), so the reverse would red a working tree. The opposite gap - an
    // entrypoint that stops being built while its committed bundle survives - is not
    // this test's to close: it closes at build time, by pruning bundles no entrypoint
    // produces, which the dist/ freshness check then sees as a deletion.
    for (const name of cli) {
      if (CLI_WITHOUT_COMMAND.has(name)) continue;
      expect(
        commands,
        `src/cli/${name}.ts has no commands/${name}.md to reach it ` +
          `(if it is not meant to be reachable, add it to CLI_WITHOUT_COMMAND)`,
      ).toContain(name);
    }
  });
});

describe(".claude-plugin manifests", () => {
  it("describes a plugin whose source directory is the one that carries plugin.json", () => {
    // given the two manifests that make this repo installable as a marketplace
    const marketplace = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "marketplace.json"), "utf8"));
    const plugin = JSON.parse(readFileSync(join(repoRoot, ".claude-plugin", "plugin.json"), "utf8"));

    // when each declared plugin source is read. A source is either a relative path, which
    // this repo uses and which can be resolved on disk, or an object naming a remote
    // ({source:"github"|"git"|"url"}), which cannot - the latter is checked for shape
    // instead of being handed to join(), which would throw a bare TypeError naming
    // nothing.
    const entries: { name: string; source: unknown }[] = marketplace.plugins;
    expect(entries.length).toBeGreaterThan(0);

    for (const { name, source } of entries) {
      if (typeof source !== "string") {
        const remote = source as { source?: string; repo?: string; url?: string };
        expect(
          ["github", "git", "url"],
          `plugin "${name}" has a source this test does not recognize: ${JSON.stringify(source)}`,
        ).toContain(remote.source);
        expect(remote.repo ?? remote.url, `remote source for "${name}" names neither a repo nor a url`).toBeTruthy();
        continue;
      }

      // then a local source is a directory holding its own plugin.json, and the name the
      // marketplace advertises is the name that plugin.json answers to - a mismatch makes
      // `/plugin install <name>@<marketplace>` resolve to nothing.
      const dir = join(repoRoot, source);
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
      entrypointNames(dir).map((name) => ({
        label: `${dir}/${name}.ts`,
        text: readFileSync(join(repoRoot, dir, `${name}.ts`), "utf8"),
      })),
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
