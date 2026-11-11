import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSkillSource, readSkillSource, skillSourceAddress } from "./skill-source.js";
import { startStandInForge } from "./stand-in-forge.js";
import type { StandInForge } from "./stand-in-forge.js";
import { plainGitServer } from "./stand-in-git.js";
import { openSqliteStore } from "../store.js";

const IDENTITY = ["-c", "user.name=Stand In", "-c", "user.email=stand-in@example.invalid"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...IDENTITY, ...args], { cwd, encoding: "utf8" }).trim();

const servers: Server[] = [];
const forges: StandInForge[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all([...servers.splice(0).map((s) => new Promise((done) => s.close(done))), ...forges.splice(0).map((f) => f.close())]);
});

/** The head a fetch answered with; a refusal fails the test with its own words. */
function headOf(read: Awaited<ReturnType<typeof fetchSkillSource>>): string {
  if ("error" in read) throw new Error(`${read.code}: ${read.error}`);
  return read.head;
}

/** One person's own machine: this machine and their network are reached, and their gh or glab answers git. */
const local = { privateNetworkForges: true, ownForgeCli: true, resolveHost: async () => ["127.0.0.1"], store: openSqliteStore(":memory:"), tenant: "solo" };

/** A skills repository served over git's HTTP on this machine with no sign-in, and a place in the data directory for its mirror. */
async function publicSkills() {
  const root = mkdtempSync(join(tmpdir(), "skill-source-"));
  const seed = join(root, "seed");
  mkdirSync(join(seed, "skills", "retry"), { recursive: true });
  mkdirSync(join(seed, ".claude-plugin"));
  writeFileSync(join(seed, "skills", "retry", "SKILL.md"), "---\nname: retry\ndescription: Retry a flaky step.\n---\n");
  writeFileSync(join(seed, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "acme-skills", version: "0.1.0" }));
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "first");
  mkdirSync(join(root, "served", "acme"), { recursive: true });
  const served = join(root, "served", "acme", "skills.git");
  execFileSync("git", ["clone", "-q", "--bare", seed, served]);
  const web = await plainGitServer(join(root, "served"), servers);
  return { root, seed, served, url: `${web}/acme/skills.git`, dir: join(root, "data", "skill-sources", "solo", "acme-skills.git") };
}

describe("a skills repository named by its git address", () => {
  it("given a public repository, when it is fetched and read, then its skills and plugin come from a mirror in the data directory, a later commit arrives on the next fetch, and the mirror's config holds no credential", async () => {
    const { seed, served, url, dir } = await publicSkills();

    const first = headOf(await fetchSkillSource(local, url, dir));
    const read = await readSkillSource(dir);
    writeFileSync(join(seed, "skills", "retry", "SKILL.md"), "---\nname: retry\ndescription: Retry a flaky step, at most twice.\n---\n");
    git(seed, "commit", "-q", "-am", "twice");
    git(seed, "push", "-q", served, "main");
    const second = headOf(await fetchSkillSource(local, url, dir));

    expect(read.skills.map((s) => s.name)).toEqual(["retry"]);
    expect(read.plugin.name).toBe("acme-skills");
    expect(second).not.toBe(first);
    expect(second).toBe(git(served, "rev-parse", "main"));
    expect((await readSkillSource(dir, first)).head).toBe(first);
    const config = readFileSync(join(dir, "config"), "utf8");
    expect(config).toContain(`url = ${url}`);
    expect(config).not.toMatch(/extraheader|credential|password|token/i);
  });

  it("given a local path, ext::, git://, an https address carrying a token, plain http to another host, an option, or ssh outside one person's machine, when it is named, then each is refused with its own code", () => {
    for (const url of ["file:///srv/skills.git", "ext::sh -c touch% /tmp/x", "git://github.com/acme/skills.git", "--upload-pack=touch", "/srv/skills.git", ""]) {
      expect(skillSourceAddress(local, url)).toMatchObject({ code: "address-not-a-repository", status: 400 });
    }
    expect(skillSourceAddress(local, "https://ada:tok@github.com/acme/skills.git")).toMatchObject({ code: "address-has-credentials" });
    expect(skillSourceAddress(local, "http://github.com/acme/skills.git")).toMatchObject({ code: "address-not-https" });
    expect(skillSourceAddress({ ownForgeCli: false }, "git@github.com:acme/skills.git")).toMatchObject({ code: "address-ssh-on-own-machine-only" });
    expect(skillSourceAddress(local, "git@github.com:acme/skills.git")).toMatchObject({ host: "github.com", forge: "github", protocol: "ssh" });
    expect(skillSourceAddress(local, "https://gitlab.com/acme/platform/skills.git")).toMatchObject({ forge: "gitlab", protocol: "https" });
  });

  it("given a name that does not resolve, one that leads to a cloud's metadata service even on one person's machine, or to this machine on an orchestrator others reach, when it is fetched, then it is refused before git reaches it and no mirror is made", async () => {
    const { root, url } = await publicSkills();
    const dir = join(root, "data", "skill-sources", "solo", "x.git");

    expect(await fetchSkillSource({ ...local, resolveHost: async () => [] }, "https://skills.example.invalid/acme/skills.git", dir)).toMatchObject({ code: "address-does-not-resolve", status: 400 });
    expect(await fetchSkillSource({ ...local, resolveHost: async () => ["169.254.169.254"] }, "https://skills.example.invalid/acme/skills.git", dir)).toMatchObject({ code: "address-link-local", status: 403 });
    expect(await fetchSkillSource({ resolveHost: async () => ["127.0.0.1"], internalForgeHosts: new Set(), store: openSqliteStore(":memory:"), tenant: "acme" }, url, dir)).toMatchObject({ code: "address-leads-inside", status: 403 });
    expect(existsSync(dir)).toBe(false);
  });

  it("given a repository git cannot clone, when it is fetched, then git's reason is said and no half mirror is left", async () => {
    const { root, url } = await publicSkills();
    const dir = join(root, "data", "skill-sources", "solo", "missing.git");

    expect(await fetchSkillSource(local, url.replace("skills.git", "missing.git"), dir)).toMatchObject({ code: "clone-failed", status: 502, error: expect.stringMatching(/git did not read 127\.0\.0\.1/) });
    expect(existsSync(dir)).toBe(false);
  });

  it("given a mirror already made, when the repository is gone on the next fetch, then the fetch is refused and the mirror keeps the head it had", async () => {
    const { served, url, dir } = await publicSkills();
    const before = headOf(await fetchSkillSource(local, url, dir));
    rmSync(served, { recursive: true, force: true });

    const after = await fetchSkillSource(local, url, dir);

    expect(after).toMatchObject({ code: "fetch-failed", status: 502 });
    expect(git(dir, "rev-parse", "HEAD")).toBe(before);
  });

  it("given a repository with no commit yet, when it is fetched, then it is refused as holding nothing to read and no mirror is left", async () => {
    const { root, url } = await publicSkills();
    execFileSync("git", ["init", "-q", "--bare", join(root, "served", "acme", "empty.git")]);
    const dir = join(root, "data", "skill-sources", "solo", "empty.git");

    const read = await fetchSkillSource(local, url.replace("skills.git", "empty.git"), dir);

    expect(read).toMatchObject({ code: "source-has-no-commit", status: 400 });
    expect(existsSync(dir)).toBe(false);
  });
});

describe("a private skills repository on GitLab, read with the person's own glab", () => {
  /** A stand-in glab on PATH that hands git the stand-in GitLab's token as the person's sign-in. */
  function ownGlab(token: string): void {
    const bin = mkdtempSync(join(tmpdir(), "own-glab-"));
    writeFileSync(join(bin, "glab"), `#!/bin/sh\ncase "$1 $2" in\n  "auth git-credential") cat >/dev/null; printf 'username=oauth2\\npassword=${token}\\n' ;;\n  *) exit 1 ;;\nesac\n`);
    chmodSync(join(bin, "glab"), 0o755);
    vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH}`);
  }

  it("given glab signed in on the person's machine, when the repository is fetched, then git reads it with glab's sign-in and the mirror holds no token; elsewhere it is not read", async () => {
    const forge = await startStandInForge("gitlab");
    forges.push(forge);
    forge.addRepo("acme/skills", { withCommit: true });
    ownGlab(forge.token);
    const root = mkdtempSync(join(tmpdir(), "skill-source-gl-"));
    const gitlab = { gitlab: { kind: "gitlab" as const, webUrl: forge.webUrl, apiUrl: `${forge.webUrl}/api/v4`, clientId: "stand-in", clientSecret: "stand-in-secret" } };
    const url = `${forge.webUrl}/acme/skills.git`;

    const read = headOf(await fetchSkillSource({ ...local, forgeApps: gitlab }, url, join(root, "mine.git")));
    const elsewhere = await fetchSkillSource({ resolveHost: async () => ["127.0.0.1"], internalForgeHosts: new Set([new URL(forge.webUrl).host]), forgeApps: gitlab, store: openSqliteStore(":memory:"), tenant: "acme" }, url, join(root, "team.git"));

    expect(read).toMatch(/^[0-9a-f]{40}$/);
    expect(readFileSync(join(root, "mine.git", "config"), "utf8")).not.toContain(forge.token);
    expect(elsewhere).toMatchObject({ code: "clone-failed", status: 502 });
    expect(existsSync(join(root, "team.git"))).toBe(false);
  });
});
