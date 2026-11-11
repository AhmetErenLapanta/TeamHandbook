import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUser, principalOf, setupFirstOwner, startSession } from "../server/accounts.js";
import { createApp } from "../server/app.js";
import type { OrchestratorContext } from "../server/app.js";
import { CSRF_HEADER, sessionCookie } from "../server/auth.js";
import type { OrchestratorEnv } from "../server/auth.js";
import { runnerOf } from "../server/machines.js";
import { orgRoutes } from "../server/orgs.js";
import { createRunnerService } from "../server/runner-service.js";
import { RUNNER_PATHS } from "../shared/runner-wire.js";
import { openSqliteStore } from "../server/store.js";
import { runnerCommand } from "./cli.js";
import { ConnectRefused, connect } from "./connect.js";
import { addressProblem, readProfile, signedCall } from "./profile.js";
import type { Fetch } from "./profile.js";

const ADDRESS = "https://orchestrator.example.invalid";

/** An organization's orchestrator answered in this process: no address resolves, no byte leaves the machine. */
async function orchestrator() {
  const store = openSqliteStore(":memory:");
  const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
  const max = await createUser(store, "acme", new Set(["Payments"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner);
  const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: "acme", allowedHosts: null };
  const app = createApp(ctx);
  const runner = new Hono<OrchestratorEnv>();
  runner.post("/api/runner/poll", async (c) => {
    const who = await runnerOf(c, ctx);
    return who instanceof Response ? who : c.json({ machine: who.machine.id, email: who.user.email });
  });
  const seen: string[] = [];
  const fetchImpl: Fetch = async (input, init) => {
    const url = new URL(String(input));
    seen.push(url.origin);
    const path = url.pathname + url.search;
    return (path === "/api/runner/poll" ? runner : app).request(path, init);
  };
  const cookie = `${sessionCookie("acme")}=${(await startSession(store, "acme", max.id)).token}`;
  const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
  const pairingCode = async () => ((await (await app.request("/api/machines/pair", { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: "{}" })).json()) as { code: string }).code;
  return { fetchImpl, pairingCode, seen };
}

describe("connecting this machine to an organization", () => {
  let dataDir: string;
  beforeEach(() => void (dataDir = mkdtempSync(join(tmpdir(), "runner-connect-"))));
  afterEach(() => rmSync(dataDir, { recursive: true, force: true }));

  it("given a one-time code from Settings, when this machine connects, then it is paired as its person, its key and token sit in a file only its user reads, and its signed calls are taken", async () => {
    const org = await orchestrator();

    const profile = await connect({ address: `${ADDRESS}/`, code: await org.pairingCode(), dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });

    expect(profile).toMatchObject({ address: ADDRESS, org: "acme", machineId: expect.stringMatching(/^mch_/), token: expect.stringMatching(/^hr_/) });
    expect(readProfile(dataDir, "acme")).toEqual(profile);
    expect(statSync(join(dataDir, "runner", "machines", "acme", "profile.json")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dataDir, "runner", "machines", "acme")).mode & 0o777).toBe(0o700);
    const answer = await signedCall(profile, "POST", "/api/runner/poll", { waitMs: 0 }, org.fetchImpl);
    expect(await answer.json()).toEqual({ machine: profile.machineId, email: "max@example.invalid" });
    expect(new Set(org.seen)).toEqual(new Set([ADDRESS]));
  });

  it("given a connected machine, when it disconnects, then the orchestrator revokes it first, so its signed calls stop working there, and its file is gone", async () => {
    const org = await orchestrator();
    const profile = await connect({ address: ADDRESS, code: await org.pairingCode(), dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    const out: string[] = [];

    const code = await runnerCommand(["disconnect", "acme"], { dataDir, out: (t) => void out.push(t), err: () => {}, fetch: org.fetchImpl });

    expect(code).toBe(0);
    expect(out).toEqual(["This machine is disconnected from acme; its key no longer works there.\n"]);
    expect(readProfile(dataDir, "acme")).toBeNull();
    expect((await signedCall(profile, "POST", "/api/runner/poll", { waitMs: 0 }, org.fetchImpl)).status).toBe(401);
  });

  it("given a code already spent, when another machine tries it, then it is refused with the sentence the orchestrator gave and nothing is kept", async () => {
    const org = await orchestrator();
    const code = await org.pairingCode();
    await connect({ address: ADDRESS, code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: org.fetchImpl });
    const other = mkdtempSync(join(tmpdir(), "runner-connect-"));

    await expect(connect({ address: ADDRESS, code, dataDir: other, name: "other", platform: "linux-x64", fetch: org.fetchImpl })).rejects.toThrow(/unknown, used or expired/);
    expect(readProfile(other, "acme")).toBeNull();
    rmSync(other, { recursive: true, force: true });
  });

  it("given an orchestrator on a newer protocol or answering as another organization, when this machine connects, then it is refused before any code is sent", async () => {
    const sent: string[] = [];
    const fetchImpl: Fetch = async (input) => (sent.push(String(input)), new Response(JSON.stringify({ protocol: 99, org: "acme" })));

    await expect(connect({ address: ADDRESS, code: "ABCD-EFGH-JKMN", dataDir, name: "m", platform: "p", fetch: fetchImpl })).rejects.toThrow(/older than the orchestrator; update it/);
    await expect(connect({ address: "http://orchestrator.example.invalid", code: "ABCD-EFGH-JKMN", dataDir, name: "m", platform: "p", fetch: fetchImpl })).rejects.toBeInstanceOf(ConnectRefused);
    expect(sent).toEqual([`${ADDRESS}/api/runner/hello`]);
    for (const org of ["../..", "acme/../../x", "..", "Acme"]) {
      const asked: string[] = [];
      const named: Fetch = async (input) => (asked.push(String(input)), new Response(JSON.stringify({ protocol: 1, org })));
      await expect(connect({ address: ADDRESS, code: "ABCD-EFGH-JKMN", dataDir, name: "m", platform: "p", fetch: named })).rejects.toThrow(/organization name this machine does not take/);
      expect(asked).toEqual([`${ADDRESS}/api/runner/hello`]);
    }
    const elsewhere: Fetch = async () => new Response(JSON.stringify({ protocol: 1, org: "globex" }));
    await expect(connect({ address: `${ADDRESS}/api/orgs/acme`, code: "ABCD-EFGH-JKMN", dataDir, name: "m", platform: "p", fetch: elsewhere })).rejects.toThrow(/another organization/);
  });

  it("given addresses that would send the token in the clear or carry more than an address, when they are checked, then only https and this machine's own are taken", () => {
    expect(addressProblem("https://orchestrator.example.invalid")).toBeNull();
    expect(addressProblem("http://127.0.0.1:8080")).toBeNull();
    expect(addressProblem("http://orchestrator.example.invalid")).toMatch(/only over https/);
    expect(addressProblem("https://user:pass@orchestrator.example.invalid")).toMatch(/more than/);
    expect(addressProblem("https://orchestrator.example.invalid/?token=x")).toMatch(/more than/);
  });

  it("given the address Settings prints on an orchestrator of several organizations, when the machine connects through its organization's routes, then it pairs and its signed calls reach that organization", async () => {
    // given
    const store = openSqliteStore(":memory:");
    const owner = await principalOf(store, await setupFirstOwner(store, "acme", "code", { code: "code", email: "ada@example.invalid", password: "correct horse battery" }));
    const max = await createUser(store, "acme", new Set(["Payments"]), { email: "max@example.invalid", role: "member", password: "correct horse battery" }, owner);
    const ctx: OrchestratorContext = { store, dataDir: "unused", tenant: "acme", allowedHosts: null, runnerService: createRunnerService({ tenant: "acme", store }) };
    const app = createApp(ctx);
    const router = orgRoutes([{ ctx, app }], { mode: "local", secure: true, allowedHosts: null });
    const fetchImpl: Fetch = async (input, init) => {
      const url = new URL(String(input));
      return router.request(url.pathname + url.search, init);
    };
    const cookie = `${sessionCookie("acme")}=${(await startSession(store, "acme", max.id)).token}`;
    const { csrf } = await (await app.request("/api/me", { headers: { cookie } })).json();
    const { code } = (await (await app.request("/api/machines/pair", { method: "POST", headers: { cookie, [CSRF_HEADER]: csrf, "content-type": "application/json" }, body: "{}" })).json()) as { code: string };

    // when
    const profile = await connect({ address: `${ADDRESS}/api/orgs/acme`, code, dataDir, name: "max-laptop", platform: "darwin-arm64", fetch: fetchImpl });
    const polled = await signedCall(profile, "POST", RUNNER_PATHS.poll, { waitMs: 0, canTake: false }, fetchImpl);

    // then
    expect(profile).toMatchObject({ org: "acme", address: `${ADDRESS}/api/orgs/acme` });
    expect(polled.status).toBe(200);
  });
});
