import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSqliteStore } from "./store.js";
import { createVault, GENERATED_KEY_FILE, maskSecrets, NO_VAULT, ownForgeCliOffered, parseSecretKey, reachedHereOnly, readSecret, SEALED_WITHOUT_KEY, singlePersonOrchestrator, storeSecret, vaultFor } from "./vault.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const dataDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-vault-"));
  dirs.push(dir);
  return dir;
};

const TOKEN = "glpat-AbCdEf0123456789xyzQ";

describe("the vault for forge tokens", () => {
  it("given a stored token, when the row is read raw and then through the vault, then the database holds no trace of the value and the vault returns it", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const vault = createVault(randomBytes(32));

    // when
    await storeSecret(store, vault, "acme", "forge:payments-skills", TOKEN, "ada@example.invalid");
    const raw = await store.getSecret("acme", "forge:payments-skills");

    // then
    expect(raw).toMatch(/^v1\./);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(Buffer.from(TOKEN).toString("base64"));
    expect(await readSecret(store, vault, "acme", "forge:payments-skills")).toBe(TOKEN);
  });

  it("given the same token sealed twice, when the two ciphertexts are compared, then they differ", () => {
    const vault = createVault(randomBytes(32));
    expect(vault.seal("acme", "forge:x", TOKEN)).not.toBe(vault.seal("acme", "forge:x", TOKEN));
  });

  it("given a ciphertext copied to another tenant's or repository's row, when it is opened there, then it fails and the error names no value", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const vault = createVault(randomBytes(32));
    await storeSecret(store, vault, "acme", "forge:payments-skills", TOKEN, "ada@example.invalid");
    const sealed = (await store.getSecret("acme", "forge:payments-skills"))!;
    await store.putSecret("acme", "forge:platform-skills", sealed, "eve@example.invalid");
    await store.putSecret("other", "forge:payments-skills", sealed, "eve@example.invalid");

    // when
    const moved = readSecret(store, vault, "acme", "forge:platform-skills");
    const otherTenant = readSecret(store, vault, "other", "forge:payments-skills");

    // then
    await expect(moved).rejects.toThrow(/does not open/);
    await expect(otherTenant).rejects.toThrow(/does not open/);
    const message = await moved.catch((e: Error) => e.message);
    expect(message).not.toContain(TOKEN);
    expect(message).not.toContain(sealed);
  });

  it("given a different key, when a stored token is opened, then it fails", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await storeSecret(store, createVault(randomBytes(32)), "acme", "forge:x", TOKEN, "ada@example.invalid");

    // when
    const attempt = readSecret(store, createVault(randomBytes(32)), "acme", "forge:x");

    // then
    await expect(attempt).rejects.toThrow(/does not open/);
  });

  it("given a token stored under a key, when the orchestrator runs without one, as after a restore that left the key behind, then reading it names the missing key", async () => {
    // given
    const store = openSqliteStore(":memory:");
    await storeSecret(store, createVault(randomBytes(32)), "acme", "forge:x", TOKEN, "ada@example.invalid");

    // when
    const attempt = readSecret(store, null, "acme", "forge:x");

    // then
    await expect(attempt).rejects.toThrow(SEALED_WITHOUT_KEY);
  });

  it("given no key configured, when a token is stored, then it is refused and nothing is written", async () => {
    // given
    const store = openSqliteStore(":memory:");

    // when
    const attempt = storeSecret(store, null, "acme", "forge:x", TOKEN, "ada@example.invalid");

    // then
    await expect(attempt).rejects.toThrow(NO_VAULT);
    expect(await store.getSecret("acme", "forge:x")).toBeNull();
  });

  it("given key texts, when they are parsed, then only 32 bytes as hex or base64 pass", () => {
    expect(parseSecretKey("ab".repeat(32))).toHaveLength(32);
    expect(parseSecretKey(randomBytes(32).toString("base64"))).toHaveLength(32);
    for (const bad of ["", "short", "ab".repeat(31), randomBytes(16).toString("base64"), "a passphrase that is long enough to be 43 c"]) {
      expect(() => parseSecretKey(bad), bad).toThrow(/32 bytes/);
    }
  });

  it("given text that repeats a token, when it is masked, then every occurrence is replaced", () => {
    expect(maskSecrets(`401 for ${TOKEN} at https://x/?t=${TOKEN}`, [TOKEN])).toBe("401 for *** at https://x/?t=***");
  });
});

describe("the key on an orchestrator without ORCHESTRATOR_SECRET_KEY", () => {
  it("given a single person's orchestrator with no key set, when it starts twice, then it makes one key readable by its user alone, keeps it, and what the first start sealed opens at the second", () => {
    // given
    const dir = dataDir();

    // when
    const first = vaultFor({}, dir, true);
    const sealed = first.vault!.seal("acme", "mcp:tracker", TOKEN);
    const second = vaultFor({}, dir, true);

    // then
    expect([first.source, second.source]).toEqual(["generated", "generated"]);
    expect(statSync(join(dir, GENERATED_KEY_FILE)).mode & 0o777).toBe(0o600);
    expect(second.vault!.open("acme", "mcp:tracker", sealed)).toBe(TOKEN);
    expect(first.said).toContain("made a key");
    expect(second.said).toContain("uses the key it made");
  });

  it("given an orchestrator others reach with no key set, even one that made a key while it was one person's, when it starts, then it keeps no secrets and says where that key is", () => {
    // given
    const dir = dataDir();
    vaultFor({}, dir, true);

    // when
    const shared = vaultFor({}, dir, false);

    // then
    expect([shared.vault, shared.source]).toEqual([null, "none"]);
    expect(shared.said).toContain(NO_VAULT);
    expect(shared.said).toContain(`ORCHESTRATOR_SECRET_KEY_FILE to it`);
  });

  it("given ORCHESTRATOR_SECRET_KEY, when a single person's orchestrator starts, then that key is used and no file is made", () => {
    // given
    const dir = dataDir();
    const key = randomBytes(32).toString("base64");

    // when
    const set = vaultFor({ ORCHESTRATOR_SECRET_KEY: key }, dir, true);

    // then
    expect([set.source, set.said]).toEqual(["set", null]);
    expect(() => statSync(join(dir, GENERATED_KEY_FILE))).toThrow();
  });

  it("given a made key file others can read, when the orchestrator starts, then it stops rather than use it", () => {
    // given
    const dir = dataDir();
    vaultFor({}, dir, true);
    chmodSync(join(dir, GENERATED_KEY_FILE), 0o644);

    // when
    const start = () => vaultFor({}, dir, true);

    // then
    expect(start).toThrow(/readable by others/);
  });

  it.each([
    ["the built-in admin on loopback", { host: "127.0.0.1", publicUrl: undefined, devAdmin: true, accounts: 0, proxied: false }, true, true],
    ["one account on loopback", { host: "127.0.0.1", publicUrl: "http://localhost:8080", devAdmin: false, accounts: 1, proxied: false }, true, true],
    ["two accounts on loopback", { host: "127.0.0.1", publicUrl: undefined, devAdmin: false, accounts: 2, proxied: false }, false, true],
    ["one account on every address", { host: "0.0.0.0", publicUrl: undefined, devAdmin: false, accounts: 1, proxied: false }, false, false],
    ["one account behind a public address", { host: "127.0.0.1", publicUrl: "https://orchestrator.example.com", devAdmin: false, accounts: 1, proxied: false }, false, false],
    ["no account yet behind a named proxy", { host: "127.0.0.1", publicUrl: undefined, devAdmin: false, accounts: 0, proxied: true }, false, false],
  ])("given %s, when it is asked whether one person alone and whether this machine alone reach the orchestrator, then it says %s and %s", (_label, at, single, here) => {
    expect([singlePersonOrchestrator(at), reachedHereOnly(at)]).toEqual([single, here]);
  });

  it.each([
    ["a local orchestrator", { local: true, cloud: false, devAdmin: false }, true],
    ["a self-hosted one run as dev-admin on loopback", { local: false, cloud: false, devAdmin: true }, true],
    ["a self-hosted one with accounts on loopback", { local: false, cloud: false, devAdmin: false }, false],
    ["a self-hosted one run as dev-admin behind a public address", { local: false, cloud: false, devAdmin: true, publicUrl: "https://orchestrator.example.com" }, false],
    ["a self-hosted one run as dev-admin behind a named proxy", { local: false, cloud: false, devAdmin: true, proxied: true }, false],
    ["the cloud", { local: false, cloud: true, devAdmin: true }, false],
  ])("given %s, when it is asked whether it opens requests with its person's own gh or glab sign-in, then it says %s", (_label, given, offered) => {
    expect(ownForgeCliOffered({ host: "127.0.0.1", publicUrl: undefined, proxied: false, ...given })).toBe(offered);
  });

  it("given the refusal an orchestrator without a key gives, when it is read, then it names what is not kept and what to do", () => {
    expect(NO_VAULT).toMatch(/sign-ins, tokens or other secrets/);
    expect(NO_VAULT).toContain("ORCHESTRATOR_SECRET_KEY");
    expect(NO_VAULT).not.toContain("forge tokens");
  });
});
