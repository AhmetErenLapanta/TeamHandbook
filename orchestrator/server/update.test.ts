import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions, notInstalledUpdate, runCommand, runningVersion, startedFrom, updateCommand, updateStatus } from "./update.js";
import type { UpdateHost } from "./update.js";

const PLATFORM = "darwin-arm64";
const BASE = "http://127.0.0.1:18799/release";
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-update-"));
  dirs.push(dir);
  return dir;
}

/** A release directory holding stand-in executables of these versions, as the release build packs them. */
function release(versions: string[], latest = versions.at(-1)!, says: (v: string) => string = (v) => `teamhandbook-orchestrator ${v}`): string {
  const dir = scratch();
  const sums: string[] = [];
  for (const version of versions) {
    const name = `handbook-orchestrator-${version}-${PLATFORM}`;
    mkdirSync(join(dir, "stage", name), { recursive: true });
    writeFileSync(join(dir, "stage", name, "handbook-orchestrator"), `#!/bin/sh\necho "${says(version)}"\n`);
    chmodSync(join(dir, "stage", name, "handbook-orchestrator"), 0o755);
    spawnSync("tar", ["-czf", join(dir, `${name}.tar.gz`), "-C", join(dir, "stage"), name], { env: { ...process.env, COPYFILE_DISABLE: "1" } });
    sums.push(`${createHash("sha256").update(readFileSync(join(dir, `${name}.tar.gz`))).digest("hex")}  ${name}.tar.gz`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
  writeFileSync(join(dir, "SHA256SUMS.sigstore.json"), "{}");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "handbook-orchestrator", version: latest }, null, 2));
  return dir;
}

/** An install of `version` as install.sh leaves it. */
function installed(version: string): string {
  const root = join(scratch(), ".handbook-orchestrator");
  mkdirSync(join(root, "versions", version), { recursive: true });
  writeFileSync(join(root, "versions", version, ".install-complete"), "");
  symlinkSync(join("versions", version), join(root, "current"));
  return root;
}

/** A stand-in cosign that keeps the arguments it was given and answers with `code`. */
function cosign(code: number): { file: string; args: () => string[] } {
  const dir = scratch();
  writeFileSync(join(dir, "cosign"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\n[ ${code} = 0 ] || echo "Error: none of the expected identities matched" >&2\nexit ${code}\n`);
  chmodSync(join(dir, "cosign"), 0o755);
  return { file: join(dir, "cosign"), args: () => (existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8").trim().split("\n") : []) };
}

function host(root: string, version: string, releaseDir: string, overrides: Partial<UpdateHost> = {}) {
  const said: string[] = [];
  const restarts: number[] = [];
  const asked: string[] = [];
  const h: UpdateHost = {
    root,
    version,
    platform: PLATFORM,
    mirror: BASE,
    cosign: cosign(0).file,
    requireSignature: false,
    fetch: async (url) => {
      const file = join(releaseDir, url.slice(BASE.length + 1));
      const ok = existsSync(file);
      return { ok, status: ok ? 200 : 404, url, bytes: async () => readFileSync(file) };
    },
    run: runCommand,
    ask: async (question) => {
      asked.push(question);
      return null;
    },
    service: { installed: () => false, restart: () => (restarts.push(1), 0) },
    say: (line) => void said.push(line),
    ...overrides,
  };
  return { h, said, restarts, asked };
}

describe("update --check", () => {
  it("given a newer release and the newest one, when it checks, then it says which and changes nothing", async () => {
    const root = installed("1.0.0");
    const newer = host(root, "1.0.0", release(["1.1.0"]));
    const newest = host(root, "1.1.0", release(["1.1.0"]));

    expect(await updateCommand(["--check"], newer.h)).toBe(0);
    expect(await updateCommand(["--check"], newest.h)).toBe(0);

    expect(newer.said).toEqual(["1.0.0 is running; 1.1.0 is out: handbook-orchestrator update moves to it"]);
    expect(newest.said).toEqual(["1.1.0 is running, the newest there is"]);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
  });
});

describe("update", () => {
  it("given a newer release, when it updates, then the new version is placed whole and current, the one before stays, and an orchestrator running now is told it keeps the old one", async () => {
    const root = installed("1.0.0");
    const { h, said } = host(root, "1.0.0", release(["1.1.0"]));

    expect(await updateCommand([], h)).toBe(0);

    expect(readlinkSync(join(root, "current"))).toBe("versions/1.1.0");
    expect(existsSync(join(root, "versions", "1.1.0", ".install-complete"))).toBe(true);
    expect(readdirSync(join(root, "versions")).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(said).toEqual(["1.1.0 is installed and current; 1.0.0 stays beside it (handbook-orchestrator update --to 1.0.0 --allow-downgrade goes back)", "an orchestrator running now keeps the version before until you start it again"]);
  });

  it("given a service runs the install, when it updates, then the service restarts on the person's yes, not without it, and --yes restarts it unasked", async () => {
    const answers: (boolean | null)[] = [true, false, null];
    for (const answer of answers) {
      const root = installed("1.0.0");
      const { h, restarts, said } = host(root, "1.0.0", release(["1.1.0"]), { ask: async () => answer, service: { installed: () => true, restart: () => 0 } });
      const counted = { n: 0 };
      h.service.restart = () => (counted.n++, 0);
      await updateCommand([], h);
      expect(counted.n).toBe(answer ? 1 : 0);
      if (!answer) expect(said.at(-1)).toBe("the service runs the version before until it restarts: handbook-orchestrator service restart");
      expect(restarts).toEqual([]);
    }
    const root = installed("1.0.0");
    const counted = { n: 0 };
    const { h, asked } = host(root, "1.0.0", release(["1.1.0"]), { service: { installed: () => true, restart: () => (counted.n++, 0) } });
    await updateCommand(["--yes"], h);
    expect(counted.n).toBe(1);
    expect(asked).toEqual([]);
  });

  it("given an archive that does not match its checksum, when it updates, then nothing is placed and current stays", async () => {
    const root = installed("1.0.0");
    const dir = release(["1.1.0"]);
    writeFileSync(join(dir, `handbook-orchestrator-1.1.0-${PLATFORM}.tar.gz`), "something else");
    const { h, said } = host(root, "1.0.0", dir);

    expect(await updateCommand([], h)).toBe(1);

    expect(said).toEqual([`handbook-orchestrator-1.1.0-${PLATFORM}.tar.gz does not match its checksum in SHA256SUMS; nothing was changed`]);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
    expect(readdirSync(join(root, "versions"))).toEqual(["1.0.0"]);
  });

  it("given an unpacked executable that answers with another version, when it updates, then nothing is placed", async () => {
    const root = installed("1.0.0");
    const { h, said } = host(root, "1.0.0", release(["1.1.0"], "1.1.0", () => "teamhandbook-orchestrator 9.9.9"));

    expect(await updateCommand([], h)).toBe(1);

    expect(said).toEqual(["the unpacked executable does not run here (it said: teamhandbook-orchestrator 9.9.9); nothing was changed"]);
    expect(readdirSync(join(root, "versions"))).toEqual(["1.0.0"]);
  });

  it("given an older release, when it updates without --allow-downgrade, then it refuses, and with it and --to it goes back", async () => {
    const root = installed("2.0.0");
    const dir = release(["1.0.0"]);

    const refused = host(root, "2.0.0", dir);
    expect(await updateCommand([], refused.h)).toBe(1);
    expect(refused.said).toEqual(["1.0.0 is older than 2.0.0; pass --allow-downgrade to go back to it"]);

    const back = host(root, "2.0.0", dir);
    expect(await updateCommand(["--to", "1.0.0", "--allow-downgrade"], back.h)).toBe(0);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
  });

  it("given a release address that is plain http elsewhere, or a redirect to one, when it updates, then it refuses before taking anything", async () => {
    const root = installed("1.0.0");
    const plain = host(root, "1.0.0", release(["1.1.0"]), { mirror: "http://releases.example.com/x" });
    const dir = release(["1.1.0"]);
    const redirected = host(root, "1.0.0", dir);
    const real = redirected.h.fetch;
    redirected.h.fetch = async (url) => ({ ...(await real(url)), url: url.replace(BASE, "http://mirror.example.com/release") });

    expect(await updateCommand([], plain.h)).toBe(1);
    expect(await updateCommand([], redirected.h)).toBe(1);

    expect(plain.said).toEqual(["the release address has to be https (plain http only on this machine): http://releases.example.com/x"]);
    expect(redirected.said).toEqual([`${BASE}/manifest.json sent it on to http://mirror.example.com/release/manifest.json, which is not https`]);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
  });

  it("given five installed versions, when it updates to a sixth, then current, the one before and the newest besides are kept and the rest go", async () => {
    const root = installed("1.4.0");
    for (const v of ["1.0.0", "1.1.0", "1.2.0", "1.3.0"]) mkdirSync(join(root, "versions", v));
    const { h } = host(root, "1.4.0", release(["2.0.0"]));

    await updateCommand([], h);

    expect(readdirSync(join(root, "versions")).sort()).toEqual(["1.4.0", "2.0.0"]);
  });

  it("given a manifest of a newer shape, when it updates, then it refuses and points at install.sh", async () => {
    const dir = release(["1.1.0"]);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 2, version: "1.1.0" }));
    const { h, said } = host(installed("1.0.0"), "1.0.0", dir);

    expect(await updateCommand([], h)).toBe(1);
    expect(said).toEqual(["the release's manifest.json is of a newer shape than this executable reads; install the newest with install.sh"]);
  });

  it("given words update does not read, when it runs, then it prints its usage", async () => {
    const { h, said } = host(installed("1.0.0"), "1.0.0", release(["1.0.0"]));
    expect(await updateCommand(["--to"], h)).toBe(2);
    expect(await updateCommand(["now"], h)).toBe(2);
    expect(said[0]).toMatch(/^usage: handbook-orchestrator update/);
  });
});

describe("update in two steps", () => {
  it("given a newer release, when it is prepared and later applied, then preparing leaves current as it was and applying makes the prepared version current", async () => {
    // given
    const root = installed("1.0.0");
    const prepare = host(root, "1.0.0", release(["1.1.0"]));

    // when
    const prepared = await updateCommand(["--prepare"], prepare.h);
    const before = readlinkSync(join(root, "current"));
    const applying = host(root, "1.0.0", release(["1.1.0"]));
    const applied = await updateCommand(["--apply"], applying.h);

    // then
    expect([prepared, applied]).toEqual([0, 0]);
    expect(before).toBe("versions/1.0.0");
    expect(prepare.said).toEqual(["1.1.0 is prepared beside 1.0.0 and checked; handbook-orchestrator update --apply makes it current"]);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.1.0");
    expect(applying.said[0]).toBe("1.1.0 is installed and current; 1.0.0 stays beside it (handbook-orchestrator update --to 1.0.0 --allow-downgrade goes back)");
    expect(await updateCommand(["--apply"], host(root, "1.1.0", release(["1.1.0"])).h)).toBe(1);
  });

  it("given nothing prepared, when it applies, then it says how to prepare and changes nothing", async () => {
    // given
    const root = installed("1.0.0");
    const { h, said } = host(root, "1.0.0", release(["1.1.0"]));

    // when
    const code = await updateCommand(["--apply"], h);

    // then
    expect(code).toBe(1);
    expect(said).toEqual(["no version is prepared; handbook-orchestrator update --prepare places the newest"]);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
  });

  it("given a release that failed to prepare, when a plain prepare runs again, then it is not tried again until it is named with --to", async () => {
    // given
    const root = installed("1.0.0");
    const dir = release(["1.1.0"]);
    writeFileSync(join(dir, `handbook-orchestrator-1.1.0-${PLATFORM}.tar.gz`), "something else");
    await updateCommand(["--prepare"], host(root, "1.0.0", dir).h);
    const asked: string[] = [];
    const again = host(root, "1.0.0", dir);
    const real = again.h.fetch;
    again.h.fetch = async (url) => (asked.push(url), real(url));

    // when
    const skipped = await updateCommand(["--prepare"], again.h);
    const named = await updateCommand(["--prepare", "--to", "1.1.0"], again.h);

    // then
    expect([skipped, named]).toEqual([1, 1]);
    expect(again.said[0]).toBe(`1.1.0 failed to prepare before (handbook-orchestrator-1.1.0-${PLATFORM}.tar.gz does not match its checksum in SHA256SUMS; nothing was changed), so it is not tried again; handbook-orchestrator update --prepare --to 1.1.0 tries it`);
    expect(asked.filter((url) => url.endsWith(".tar.gz"))).toHaveLength(1);
    expect(readdirSync(join(root, "versions"))).toEqual(["1.0.0"]);
  });

  it("given an update state this executable did not write, when it updates, prepares or applies, then it updates nothing and says to remove the file", async () => {
    // given
    const root = installed("1.0.0");
    writeFileSync(join(root, "update-state.json"), "{ not json");
    const { h, said } = host(root, "1.0.0", release(["1.1.0"]));

    // when
    const codes = [await updateCommand([], h), await updateCommand(["--prepare"], h), await updateCommand(["--apply"], h)];

    // then
    expect(codes).toEqual([1, 1, 1]);
    expect(new Set(said)).toEqual(new Set([`${join(root, "update-state.json")} does not read as this executable's update state, so it updates nothing; remove the file to update again`]));
    expect(readdirSync(join(root, "versions"))).toEqual(["1.0.0"]);
  });

  it("given two steps asked together, or --apply with a version, when they are read, then it prints its usage", async () => {
    // given
    const { h } = host(installed("1.0.0"), "1.0.0", release(["1.1.0"]));

    // when
    const codes = [await updateCommand(["--check", "--prepare"], h), await updateCommand(["--prepare", "--apply"], h), await updateCommand(["--apply", "--to", "1.1.0"], h)];

    // then
    expect(codes).toEqual([2, 2, 2]);
  });
});

describe("what the web's update row reads", () => {
  it("given a prepared version and one that failed, when the status is read, then it names both without a request, and an unreadable state is a refusal", async () => {
    // given
    const root = installed("1.0.0");
    const asked: string[] = [];
    const prepared = host(root, "1.0.0", release(["1.1.0"]));
    await updateCommand(["--prepare"], prepared.h);
    const watching = host(root, "1.0.0", release(["1.1.0"]), { fetch: async (url) => (asked.push(url), { ok: false, status: 404, url, bytes: async () => Buffer.alloc(0) }) });

    // when
    const status = updateStatus(watching.h);
    writeFileSync(join(root, "update-state.json"), "[]");
    const unreadable = updateStatus(watching.h);

    // then
    expect(status).toEqual({ running: "1.0.0", prepared: "1.1.0", failed: null });
    expect(asked).toEqual([]);
    expect(unreadable).toHaveProperty("refused");
  });

  it("given a newer release, the newest, or a mirror that holds no manifest, when a check is asked, then it says which, and a missing manifest is a refusal", async () => {
    // given
    const root = installed("1.0.0");

    // when
    const newer = await checkForUpdate(host(root, "1.0.0", release(["1.1.0"])).h);
    const same = await checkForUpdate(host(root, "1.1.0", release(["1.1.0"])).h);
    const empty = scratch();
    const missing = await checkForUpdate(host(root, "1.0.0", empty).h);

    // then
    expect(newer).toEqual({ running: "1.0.0", newest: "1.1.0", newer: true });
    expect(same).toEqual({ running: "1.1.0", newest: "1.1.0", newer: false });
    expect(missing).toEqual({ refused: `${BASE}/manifest.json does not exist` });
  });

  it("given an executable inside versions/<version> and one outside the install, when its version is read, then the first is named and the second is none", () => {
    // given
    const root = installed("1.2.3");
    writeFileSync(join(root, "versions", "1.2.3", "handbook-orchestrator"), "");
    const elsewhere = join(scratch(), "handbook-orchestrator");
    writeFileSync(elsewhere, "");

    // when
    const inside = runningVersion(join(root, "current", "handbook-orchestrator"), root);
    const outside = runningVersion(elsewhere, root);

    // then
    expect([inside, outside]).toEqual(["1.2.3", null]);
  });
});

describe("update and the release signature", () => {
  it("given cosign, when it updates, then SHA256SUMS is checked against the release workflow of the target version's tag before the archive is taken", async () => {
    const signer = cosign(0);
    const { h } = host(installed("1.0.0"), "1.0.0", release(["1.1.0"]), { cosign: signer.file });

    expect(await updateCommand([], h)).toBe(0);

    const args = signer.args();
    expect(args[0]).toBe("verify-blob");
    expect(args[args.indexOf("--certificate-identity") + 1]).toBe("https://github.com/AhmetErenLapanta/TeamHandbook/.github/workflows/orchestrator-release.yml@refs/tags/handbook-orchestrator-v1.1.0");
    expect(args[args.indexOf("--certificate-oidc-issuer") + 1]).toBe("https://token.actions.githubusercontent.com");
  });

  it("given a signature cosign refuses, when it updates, then nothing is placed and current stays", async () => {
    const root = installed("1.0.0");
    const { h, said } = host(root, "1.0.0", release(["1.1.0"]), { cosign: cosign(1).file });

    expect(await updateCommand([], h)).toBe(1);

    expect(said).toEqual([`SHA256SUMS at ${BASE} is not signed by the release workflow for 1.1.0; nothing was changed (cosign: Error: none of the expected identities matched)`]);
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
    expect(readdirSync(join(root, "versions"))).toEqual(["1.0.0"]);
  });

  it("given no cosign, or a mirror without the signature, when it updates, then it says the signature was not checked and updates on the checksums", async () => {
    const dir = release(["1.1.0"]);
    const without = host(installed("1.0.0"), "1.0.0", dir, { cosign: null });
    const unsignedDir = release(["1.1.0"]);
    rmSync(join(unsignedDir, "SHA256SUMS.sigstore.json"));
    const unsigned = host(installed("1.0.0"), "1.0.0", unsignedDir);

    expect(await updateCommand([], without.h)).toBe(0);
    expect(await updateCommand([], unsigned.h)).toBe(0);

    expect(without.said[0]).toBe("cosign is not installed, so the release signature was not checked; the checksums were");
    expect(unsigned.said[0]).toBe("the mirror holds no SHA256SUMS.sigstore.json, so the signature was not checked; the checksums were");
  });

  it("given HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE=1, when cosign or the signature is missing, then nothing is placed", async () => {
    const unsignedDir = release(["1.1.0"]);
    rmSync(join(unsignedDir, "SHA256SUMS.sigstore.json"));
    const noCosign = host(installed("1.0.0"), "1.0.0", release(["1.1.0"]), { cosign: null, requireSignature: true });
    const noSignature = host(installed("1.0.0"), "1.0.0", unsignedDir, { requireSignature: true });

    expect(await updateCommand([], noCosign.h)).toBe(1);
    expect(await updateCommand([], noSignature.h)).toBe(1);

    expect(noCosign.said).toEqual(["HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE is 1 and cosign is not installed to check the signature"]);
    expect(noSignature.said).toEqual([`${BASE}/SHA256SUMS.sigstore.json does not exist; nothing was changed`]);
  });
});

describe("the order of release versions", () => {
  it("given versions with longer and shorter parts and pre-releases, when they are compared, then numbers count as numbers and a pre-release comes before its release", () => {
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1);
    expect(compareVersions("1.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(compareVersions("1.0.0", "1.0.0-rc.1")).toBe(1);
    expect(compareVersions("0.9.0", "1.0.0")).toBe(-1);
  });
});

describe("a copy install.sh did not place", () => {
  it("given a clone, a worktree of one, npx's cache and a package elsewhere, when each is asked how it updates, then a clone names its folder and git pull, npx names @latest, and the rest names both ways", () => {
    // given
    const clone = join(scratch(), "TeamHandbook");
    mkdirSync(join(clone, ".git"), { recursive: true });
    mkdirSync(join(clone, "orchestrator"));
    const worktree = join(scratch(), "work-copy");
    mkdirSync(join(worktree, "orchestrator"), { recursive: true });
    writeFileSync(join(worktree, ".git"), "gitdir: elsewhere\n");
    const npx = join(scratch(), "_npx", "4f2a", "node_modules", "teamhandbook-orchestrator");
    const elsewhere = join(scratch(), "orchestrator");

    // when
    const answers = [clone, worktree].map((dir) => startedFrom(join(dir, "orchestrator"))).concat([startedFrom(npx), startedFrom(elsewhere)]);

    // then
    expect(answers).toEqual([{ from: "clone", folder: clone }, { from: "clone", folder: worktree }, { from: "npx" }, null]);
    expect(notInstalledUpdate(answers[0]!)).toBe(`this orchestrator runs from a clone; in ${clone} run git pull, then npm start`);
    expect(notInstalledUpdate(answers[2]!)).toContain("npx teamhandbook-orchestrator@latest");
    expect(notInstalledUpdate(null)).toContain("git pull");
  });
});
