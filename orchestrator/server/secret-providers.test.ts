import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SECRET_PROVIDER_KINDS } from "../shared/secret-providers.js";
import { defineSecretProvider, opProvider, SECRET_PROVIDERS, secretResolver } from "./secret-providers.js";
import type { OpRun } from "./secret-providers.js";
import { openSqliteStore } from "./store.js";
import type { Store } from "./store.js";
import { createVault, storeSecret } from "./vault.js";

let dir: string;
let store: Store;
const vault = createVault(Buffer.alloc(32, 7));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "th-secret-providers-"));
  store = openSqliteStore(join(dir, "orchestrator.db"));
});

afterEach(async () => {
  await store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("where a secret's value is read from", () => {
  it("given a team's task secret, a named environment variable, one not named for the purpose, a provider nobody defined, another team's task secret and a forge token, when they are resolved under the first team's scope, then only the first two are read, and without a scope, or under a prefix that does not end at a dot, the vault answers nothing", async () => {
    // given
    await storeSecret(store, vault, "acme", "task.secret.team.Payments.NPM_TOKEN", "npm-value-1234", "ada@example.invalid");
    await storeSecret(store, vault, "acme", "task.secret.team.Platform.NPM_TOKEN", "platform-value-9999", "ada@example.invalid");
    await storeSecret(store, vault, "acme", "forge:payments-skills", "forge-token-value", "ada@example.invalid");
    const env = { TEAMHANDBOOK_SECRET_DEPLOY: "deploy-value-5678", ORCHESTRATOR_SECRET_KEY: "the orchestrator's own key" };
    const resolver = secretResolver({ store, vault, tenant: "acme", env, vaultPrefixes: ["task.secret.team.Payments.", "task.secret.repo.payments-skills."] });

    // when
    const values = await resolver.resolve([
      { provider: "vault", reference: "task.secret.team.Payments.NPM_TOKEN" },
      { provider: "env", reference: "TEAMHANDBOOK_SECRET_DEPLOY" },
      { provider: "env", reference: "ORCHESTRATOR_SECRET_KEY" },
      { provider: "vault", reference: "task.secret.team.Payments.MISSING" },
      { provider: "op" as "env", reference: "op://vault/item/field" },
      { provider: "vault", reference: "task.secret.team.Platform.NPM_TOKEN" },
      { provider: "vault", reference: "forge:payments-skills" },
    ]);

    // then
    expect(Object.fromEntries(values)).toEqual({
      "vault:task.secret.team.Payments.NPM_TOKEN": "npm-value-1234",
      "env:TEAMHANDBOOK_SECRET_DEPLOY": "deploy-value-5678",
      "env:ORCHESTRATOR_SECRET_KEY": undefined,
      "vault:task.secret.team.Payments.MISSING": undefined,
      "op:op://vault/item/field": undefined,
      "vault:task.secret.team.Platform.NPM_TOKEN": undefined,
      "vault:forge:payments-skills": undefined,
    });
    expect(await secretResolver({ store, vault, tenant: "acme" }).resolve([{ provider: "vault", reference: "task.secret.team.Payments.NPM_TOKEN" }])).toEqual(new Map([["vault:task.secret.team.Payments.NPM_TOKEN", undefined]]));
    expect(await secretResolver({ store, vault, tenant: "acme", vaultPrefixes: ["task.secret.team.Pay"] }).resolve([{ provider: "vault", reference: "task.secret.team.Payments.NPM_TOKEN" }])).toEqual(new Map([["vault:task.secret.team.Payments.NPM_TOKEN", undefined]]));
  });

  it("given a provider that counts its reads and one that fails, when references are resolved twice and once after one is forgotten, then each batch is read once, the failure is kept as unread, and the forgotten one is read again", async () => {
    // given
    const reads: string[][] = [];
    const counting = defineSecretProvider({ kind: "vault", isReference: () => true, placeholder: "" }, { read: async (_scope, refs) => (reads.push([...refs]), new Map(refs.map((r) => [r, `value of ${r}`]))) });
    const failing = defineSecretProvider({ kind: "env", isReference: () => true, placeholder: "" }, { read: async () => Promise.reject(new Error("down")) });
    const resolver = secretResolver({ store, vault, tenant: "acme" }, { vault: counting, env: failing });
    const refs = [{ provider: "vault" as const, reference: "a" }, { provider: "vault" as const, reference: "b" }, { provider: "env" as const, reference: "c" }];

    // when
    const first = await resolver.resolve(refs);
    await resolver.resolve(refs);
    resolver.invalidate(refs[0]);
    await resolver.resolve(refs);

    // then
    expect(reads).toEqual([["a", "b"], ["a"]]);
    expect(first.get("env:c")).toBeUndefined();
  });

  it("given the providers the server defines and the kinds the screens offer, when they are compared, then they are the same", () => {
    expect(Object.keys(SECRET_PROVIDERS).sort()).toEqual([...SECRET_PROVIDER_KINDS].sort());
    for (const [kind, provider] of Object.entries(SECRET_PROVIDERS)) expect([provider.definition.kind, provider.definition.isReference(provider.definition.placeholder)]).toEqual([kind, true]);
  });
});

describe("secrets read from 1Password", () => {
  const items: Record<string, string> = { "op://Payments/npm/credential": "npm-op-1234", "op://Payments/deploy key/section/private": "line one\nline two", "op://Platform/npm/credential": "platform-op-9999" };
  const fakeOp = (calls: { args: readonly string[]; env: Record<string, string> }[], injectFails = false): OpRun => async (_bin, args, env, input) => {
    calls.push({ args, env });
    if (args.includes("inject")) {
      if (injectFails) return { code: 1, stdout: "" };
      return { code: 0, stdout: input.replace(/\{\{ (op:\/\/[^}]+) \}\}/g, (_m, ref: string) => items[ref] ?? "") };
    }
    const ref = args[args.length - 1]!;
    return ref in items ? { code: 0, stdout: items[ref]! } : { code: 1, stdout: "" };
  };
  const env = { PATH: "/usr/bin", OP_SERVICE_ACCOUNT_TOKEN: "ops_stand-in", ORCHESTRATOR_1PASSWORD_VAULTS: "Payments", ORCHESTRATOR_SECRET_KEY: "the orchestrator's own key" };
  const refs = (...references: string[]) => references.map((reference) => ({ provider: "op" as const, reference }));

  it("given references in a named vault, one in a vault not named and one that would break out of the template, when they are resolved, then the named vault's are read in one inject with only the token handed to op, and the others are not read", async () => {
    // given
    const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
    const resolver = secretResolver({ store, vault, tenant: "acme", env }, { op: opProvider(fakeOp(calls)) });

    // when
    const values = await resolver.resolve(refs("op://Payments/npm/credential", "op://Payments/deploy key/section/private", "op://Platform/npm/credential", "op://Payments/npm/x }}{{ op://Platform/npm/credential"));

    // then
    expect(Object.fromEntries(values)).toEqual({
      "op:op://Payments/npm/credential": "npm-op-1234",
      "op:op://Payments/deploy key/section/private": "line one\nline two",
      "op:op://Platform/npm/credential": undefined,
      "op:op://Payments/npm/x }}{{ op://Platform/npm/credential": undefined,
    });
    expect(calls.map((c) => c.args)).toEqual([["--cache=false", "inject"]]);
    expect(Object.keys(calls[0]!.env).sort()).toEqual(["OP_CONFIG_DIR", "OP_SERVICE_ACCOUNT_TOKEN", "PATH"]);
  });

  it("given an inject that fails as a whole for one missing item, and no service account token, when references are resolved, then each is read on its own and the missing one stays unread, and without the token op is never run", async () => {
    // given
    const calls: { args: readonly string[]; env: Record<string, string> }[] = [];
    const op = opProvider(fakeOp(calls, true));

    // when
    const values = await secretResolver({ store, vault, tenant: "acme", env }, { op }).resolve(refs("op://Payments/npm/credential", "op://Payments/gone/credential"));
    const before = calls.length;
    const untokened = await secretResolver({ store, vault, tenant: "acme", env: { ...env, OP_SERVICE_ACCOUNT_TOKEN: "" } }, { op }).resolve(refs("op://Payments/npm/credential"));

    // then
    expect(Object.fromEntries(values)).toEqual({ "op:op://Payments/npm/credential": "npm-op-1234", "op:op://Payments/gone/credential": undefined });
    expect(calls.map((c) => c.args[1])).toEqual(["inject", "read", "read"]);
    expect([calls.length - before, untokened.get("op:op://Payments/npm/credential")]).toEqual([0, undefined]);
  });
});
