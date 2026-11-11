import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Metrics, renderMetrics } from "../metrics.js";
import { forgeMeter } from "./forge-metrics.js";
import { BACKOFF_MIN_MS, forgeHttp, ForgeHttpError, forgetForgeState, inBackground } from "./http.js";

const TOKEN = "ghp_stand_in_http_token_0001";
const SHA = "c0ffee".padEnd(40, "0");

const servers: Server[] = [];
beforeEach(() => forgetForgeState());
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

type Answer = { status: number; headers?: Record<string, string>; body?: unknown };

/** A forge that records what it was sent and answers each call with the next of `answers`, the last one again once they run out. */
async function forge(answers: Answer[]) {
  const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", headers: req.headers });
    const answer = answers[Math.min(seen.length - 1, answers.length - 1)]!;
    res.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    res.end(answer.status === 304 ? undefined : JSON.stringify(answer.body ?? {}));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const http = forgeHttp("GitHub", `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`, TOKEN, { authorization: `Bearer ${TOKEN}` }, fetch);
  return { http, seen };
}

describe("a forge that asks the orchestrator to wait", () => {
  it("given a 429 with Retry-After, when the next call comes before then, then it is not sent and says until when", async () => {
    const { http, seen } = await forge([{ status: 429, headers: { "retry-after": "120" }, body: { message: "slow down" } }]);
    await expect(http.request("GET", "/repos/acme/skills/pulls/1")).rejects.toBeInstanceOf(ForgeHttpError);

    const held = await http.request("GET", "/repos/acme/skills/pulls/2").catch((err: ForgeHttpError) => err);

    expect(seen).toHaveLength(1);
    expect(held).toMatchObject({ status: 429, retryAt: expect.any(String) });
    expect(Date.parse((held as ForgeHttpError).retryAt!) - Date.now()).toBeGreaterThan(100_000);
  });

  it("given a forge that says to wait a second, when it is called again at once, then the orchestrator still waits its least", async () => {
    const { http } = await forge([{ status: 429, headers: { "retry-after": "1" } }]);
    await http.request("GET", "/repos/acme/skills").catch(() => undefined);
    const held = (await http.request("GET", "/repos/acme/skills").catch((err: ForgeHttpError) => err)) as ForgeHttpError;
    expect(Date.parse(held.retryAt!) - Date.now()).toBeGreaterThan(BACKOFF_MIN_MS - 5_000);
  });
});

describe("the quota left for people", () => {
  it("given a forge with under a tenth of its quota left, when background work and a person each call, then the background call is held and the person's is sent", async () => {
    const reset = String(Math.floor(Date.now() / 1000) + 600);
    const { http, seen } = await forge([{ status: 200, headers: { "x-ratelimit-remaining": "40", "x-ratelimit-limit": "5000", "x-ratelimit-reset": reset }, body: { ok: true } }]);
    await http.request("GET", "/repos/acme/skills");

    await expect(inBackground(() => http.request("GET", "/repos/acme/skills/pulls/1"))).rejects.toMatchObject({ status: 429 });
    await expect(http.request("GET", "/repos/acme/skills/pulls/1")).resolves.toEqual({ ok: true });
    expect(seen).toHaveLength(2);
  });
});

describe("asking again for what has not changed", () => {
  it("given an answer with an ETag, when the same thing is asked again and the forge says not modified, then the kept answer is given", async () => {
    const { http, seen } = await forge([{ status: 200, headers: { etag: '"v1"' }, body: { title: "first" } }, { status: 304 }]);

    expect(await http.request("GET", "/repos/acme/skills/pulls/1")).toEqual({ title: "first" });
    expect(await http.request("GET", "/repos/acme/skills/pulls/1")).toEqual({ title: "first" });
    expect(seen[1]!.headers["if-none-match"]).toBe('"v1"');
  });
});

describe("the forge calls in the metrics", () => {
  it("given calls naming a project, a branch and a commit, when the metrics are read, then each call is counted by operation and none of those names, nor the token, is there", async () => {
    const { http } = await forge([{ status: 200, headers: { "x-ratelimit-remaining": "4990", "x-ratelimit-limit": "5000" }, body: {} }]);
    await http.request("GET", "/repos/acme/secret-payments/pulls/7");
    await http.request("GET", `/repos/acme/secret-payments/commits/${SHA}/check-runs?per_page=100`);
    await http.request("GET", "/repos/acme/secret-payments/git/ref/heads/handbook/hidden-branch");

    const text = await renderMetrics([], new Metrics(), forgeMeter);

    expect(text).toMatch(/teamhandbook_orchestrator_forge_calls_total\{forge="GitHub",host="127\.0\.0\.1:\d+",operation="get request",status="2xx"\} 1/);
    expect(text).toMatch(/operation="get checks"/);
    expect(text).toMatch(/operation="get ref"/);
    expect(text).toMatch(/teamhandbook_orchestrator_forge_quota_remaining\{forge="GitHub",host="127\.0\.0\.1:\d+"\} 4990/);
    for (const leak of ["secret-payments", "hidden-branch", SHA, TOKEN, "per_page"]) expect(text).not.toContain(leak);
  });
});
