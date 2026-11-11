import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

// scripts/install.sh against a stand-in release mirror on this machine: no request leaves it.
const INSTALL = join(import.meta.dirname, "..", "scripts", "install.sh");
const PLATFORM = `${process.platform}-${process.arch === "arm64" ? "arm64" : "x64"}`;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-install-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A release directory with one stand-in executable per version, packed as the release build packs it. */
async function release(versions: string[], latest = versions.at(-1)!): Promise<string> {
  const dir = scratch();
  const sums: string[] = [];
  for (const version of versions) {
    const name = `handbook-orchestrator-${version}-${PLATFORM}`;
    const stage = join(dir, "stage", name);
    mkdirSync(join(stage, "web"), { recursive: true });
    writeFileSync(join(stage, "handbook-orchestrator"), `#!/bin/sh\n[ "$1" = --version ] && echo "teamhandbook-orchestrator ${version}"\n`);
    chmodSync(join(stage, "handbook-orchestrator"), 0o755);
    writeFileSync(join(stage, "web", "index.html"), "<!doctype html>\n");
    await run("tar", ["-czf", join(dir, `${name}.tar.gz`), "-C", join(dir, "stage"), name], { COPYFILE_DISABLE: "1" });
    sums.push(`${createHash("sha256").update(readFileSync(join(dir, `${name}.tar.gz`))).digest("hex")}  ${name}.tar.gz`);
  }
  writeFileSync(join(dir, "SHA256SUMS"), sums.join("\n") + "\n");
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ name: "handbook-orchestrator", version: latest }, null, 2) + "\n");
  return dir;
}

async function mirror(dir: string): Promise<{ url: string; asked: string[] }> {
  const asked: string[] = [];
  const server: Server = createServer((req, res) => {
    asked.push(req.url!);
    const file = join(dir, req.url!.slice(1));
    if (!/^\/[\w.+-]+$/.test(req.url!) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200).end(readFileSync(file));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, asked };
}

// No cosign this machine has installed takes part: a test that wants one puts a stand-in first.
const PATH_WITHOUT_COSIGN = process.env.PATH!.split(":").filter((dir) => !existsSync(join(dir, "cosign"))).join(":");

function run(program: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { env: { PATH: PATH_WITHOUT_COSIGN, ...env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => resolve({ code: code ?? 1, out }));
  });
}

function install(home: string, base: string, extra: Record<string, string> = {}) {
  return run("sh", [INSTALL], { HOME: home, HANDBOOK_ORCHESTRATOR_RELEASE_BASE_URL: base, ...extra });
}

/** A stand-in cosign that keeps the arguments it was given and answers with `code`; the PATH that finds it first. */
function cosign(code: number): { path: string; args: () => string[] } {
  const dir = scratch();
  writeFileSync(join(dir, "cosign"), `#!/bin/sh\nprintf '%s\\n' "$@" > "${join(dir, "args")}"\n[ ${code} = 0 ] || echo "Error: none of the expected identities matched" >&2\nexit ${code}\n`);
  chmodSync(join(dir, "cosign"), 0o755);
  return { path: `${dir}:${PATH_WITHOUT_COSIGN}`, args: () => (existsSync(join(dir, "args")) ? readFileSync(join(dir, "args"), "utf8").trim().split("\n") : []) };
}

describe("install.sh", () => {
  it("given a release with this platform's archive, when it installs, then the version is unpacked whole, current points at it, the command is linked and runs", async () => {
    const home = scratch();
    const { url } = await mirror(await release(["1.0.0"]));

    const done = await install(home, url);

    expect(done.code).toBe(0);
    expect(done.out).toContain("installed 1.0.0; start it with: handbook-orchestrator");
    const root = join(home, ".handbook-orchestrator");
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
    expect(existsSync(join(root, "versions", "1.0.0", ".install-complete"))).toBe(true);
    expect(existsSync(join(root, "versions", "1.0.0", "web", "index.html"))).toBe(true);
    expect(readlinkSync(join(home, ".local", "bin", "handbook-orchestrator"))).toBe(join(root, "current", "handbook-orchestrator"));
    expect((await run(join(home, ".local", "bin", "handbook-orchestrator"), ["--version"])).out.trim()).toBe("teamhandbook-orchestrator 1.0.0");
    expect(readdirSync(join(root, "versions"))).toEqual(["1.0.0"]);
  });

  it("given an archive that does not match its checksum, when it installs, then it stops before writing anything", async () => {
    const home = scratch();
    const dir = await release(["1.0.0"]);
    writeFileSync(join(dir, `handbook-orchestrator-1.0.0-${PLATFORM}.tar.gz`), "not the archive that was summed");
    const { url } = await mirror(dir);

    const done = await install(home, url);

    expect(done.code).toBe(1);
    expect(done.out).toContain("does not match its checksum in SHA256SUMS; nothing was installed");
    expect(existsSync(join(home, ".handbook-orchestrator", "versions", "1.0.0"))).toBe(false);
    expect(existsSync(join(home, ".handbook-orchestrator", "current"))).toBe(false);
    expect(existsSync(join(home, ".local"))).toBe(false);
  });

  it("given a release with no build for this platform, when it installs, then it says so and installs nothing", async () => {
    const home = scratch();
    const dir = await release(["1.0.0"]);
    writeFileSync(join(dir, "SHA256SUMS"), `${"0".repeat(64)}  handbook-orchestrator-1.0.0-plan9-mips.tar.gz\n`);
    const { url } = await mirror(dir);

    const done = await install(home, url);

    expect(done.code).toBe(1);
    expect(done.out).toContain(`release 1.0.0 has no build for ${PLATFORM}`);
    expect(done.out).toContain("npx teamhandbook-orchestrator@latest");
    expect(existsSync(join(home, ".handbook-orchestrator", "current"))).toBe(false);
  });

  it("given an install of 1.0.0, when 1.1.0 is installed and then 1.0.0 is pinned, then current moves each time, both versions stay, and the second 1.0.0 is not unpacked again", async () => {
    const home = scratch();
    const { url, asked } = await mirror(await release(["1.0.0", "1.1.0"]));
    const root = join(home, ".handbook-orchestrator");
    await install(home, url, { HANDBOOK_ORCHESTRATOR_VERSION: "1.0.0" });

    const newer = await install(home, url);
    const atNewer = readlinkSync(join(root, "current"));
    const back = await install(home, url, { HANDBOOK_ORCHESTRATOR_VERSION: "1.0.0" });

    expect([newer.code, back.code]).toEqual([0, 0]);
    expect(atNewer).toBe("versions/1.1.0");
    expect(readlinkSync(join(root, "current"))).toBe("versions/1.0.0");
    expect(back.out).toContain("1.0.0 is installed already");
    expect(readdirSync(join(root, "versions")).sort()).toEqual(["1.0.0", "1.1.0"]);
    expect(asked.filter((u) => u === "/manifest.json")).toHaveLength(1);
  });

  it("given an unpacked executable that does not answer with its version, when it installs, then nothing is made current", async () => {
    const home = scratch();
    const dir = await release(["1.0.0"]);
    const { url } = await mirror(dir);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: "1.0.0" }));
    const bad = await release(["2.0.0"]);
    const name = `handbook-orchestrator-2.0.0-${PLATFORM}`;
    rmSync(join(bad, `${name}.tar.gz`));
    mkdirSync(join(bad, "stage2", name), { recursive: true });
    writeFileSync(join(bad, "stage2", name, "handbook-orchestrator"), "#!/bin/sh\necho something else\n");
    chmodSync(join(bad, "stage2", name, "handbook-orchestrator"), 0o755);
    await run("tar", ["-czf", join(bad, `${name}.tar.gz`), "-C", join(bad, "stage2"), name], { COPYFILE_DISABLE: "1" });
    writeFileSync(join(bad, "SHA256SUMS"), `${createHash("sha256").update(readFileSync(join(bad, `${name}.tar.gz`))).digest("hex")}  ${name}.tar.gz\n`);
    const badMirror = await mirror(bad);
    await install(home, url);

    const done = await install(home, badMirror.url);

    expect(done.code).toBe(1);
    expect(done.out).toContain("the unpacked executable does not run here (it said: something else); nothing was installed");
    expect(readlinkSync(join(home, ".handbook-orchestrator", "current"))).toBe("versions/1.0.0");
    expect(readdirSync(join(home, ".handbook-orchestrator", "versions"))).toEqual(["1.0.0"]);
  });

  it.each(["http://releases.example.com/handbook", "ftp://127.0.0.1/handbook", "http://127.0.0.1.example.com/x"])("given the plain address %s as the mirror, when it installs, then it refuses before reaching it", async (base) => {
    const home = scratch();

    const done = await install(home, base);

    expect(done.code).toBe(1);
    expect(done.out).toContain(`the release address has to be https (plain http only on this machine): ${base}`);
    expect(existsSync(join(home, ".handbook-orchestrator"))).toBe(false);
  });

  it("given a manifest of a newer shape, when it installs, then it refuses and installs nothing", async () => {
    const home = scratch();
    const dir = await release(["1.0.0"]);
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({ schema: 2, version: "1.0.0" }, null, 2));
    const { url } = await mirror(dir);

    const done = await install(home, url);

    expect(done.code).toBe(1);
    expect(done.out).toContain(`manifest.json at ${url} is of a newer shape than this script reads`);
    expect(existsSync(join(home, ".handbook-orchestrator", "current"))).toBe(false);
  });

  it("given a mirror that holds nothing, when it installs, then it names what it could not read", async () => {
    const home = scratch();
    const { url } = await mirror(scratch());

    const done = await install(home, url);

    expect(done.code).toBe(1);
    expect(done.out).toContain(`could not read manifest.json at ${url}`);
  });
});

describe("install.sh and the release signature", () => {
  it("given cosign and a signed SHA256SUMS, when it installs, then cosign checks it against the release workflow of that version's tag before anything is written", async () => {
    const home = scratch();
    const dir = await release(["1.0.0"]);
    writeFileSync(join(dir, "SHA256SUMS.sigstore.json"), "{}");
    const { url } = await mirror(dir);
    const signer = cosign(0);

    const done = await install(home, url, { PATH: signer.path });

    expect(done.code).toBe(0);
    expect(done.out).toContain("SHA256SUMS is signed by the release workflow for 1.0.0");
    const args = signer.args();
    expect(args[0]).toBe("verify-blob");
    expect(args[args.indexOf("--certificate-identity") + 1]).toBe("https://github.com/AhmetErenLapanta/TeamHandbook/.github/workflows/orchestrator-release.yml@refs/tags/handbook-orchestrator-v1.0.0");
    expect(args[args.indexOf("--certificate-oidc-issuer") + 1]).toBe("https://token.actions.githubusercontent.com");
    expect(args.at(-1)!.endsWith("/SHA256SUMS")).toBe(true);
  });

  it("given a signature cosign refuses, when it installs, then nothing is installed", async () => {
    const home = scratch();
    const dir = await release(["1.0.0"]);
    writeFileSync(join(dir, "SHA256SUMS.sigstore.json"), "{}");
    const { url } = await mirror(dir);

    const done = await install(home, url, { PATH: cosign(1).path });

    expect(done.code).toBe(1);
    expect(done.out).toContain(`SHA256SUMS at ${url} is not signed by the release workflow for 1.0.0; nothing was installed (cosign: Error: none of the expected identities matched)`);
    expect(existsSync(join(home, ".handbook-orchestrator", "versions", "1.0.0"))).toBe(false);
  });

  it("given no cosign, or a mirror without the signature, when it installs, then it says the signature was not checked and installs on the checksums", async () => {
    const dir = await release(["1.0.0"]);
    const { url } = await mirror(dir);

    const without = await install(scratch(), url);
    const unsigned = await install(scratch(), url, { PATH: cosign(0).path });

    expect([without.code, unsigned.code]).toEqual([0, 0]);
    expect(without.out).toContain("cosign is not installed, so the release signature was not checked; the checksums were");
    expect(unsigned.out).toContain("the mirror holds no SHA256SUMS.sigstore.json, so the signature was not checked; the checksums were");
  });

  it("given HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE=1, when cosign or the signature is missing, then nothing is installed", async () => {
    const home = scratch();
    const { url } = await mirror(await release(["1.0.0"]));

    const noCosign = await install(home, url, { HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE: "1" });
    const noSignature = await install(home, url, { HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE: "1", PATH: cosign(0).path });

    expect([noCosign.code, noSignature.code]).toEqual([1, 1]);
    expect(noCosign.out).toContain("HANDBOOK_ORCHESTRATOR_REQUIRE_SIGNATURE is 1 and cosign is not installed to check the signature");
    expect(noSignature.out).toContain(`could not read SHA256SUMS.sigstore.json at ${url}; nothing was installed`);
    expect(existsSync(join(home, ".handbook-orchestrator", "current"))).toBe(false);
  });
});
