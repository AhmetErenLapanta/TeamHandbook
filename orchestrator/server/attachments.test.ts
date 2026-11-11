import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MiddlewareHandler } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import type { OrchestratorContext } from "./app.js";
import { attachmentPath, attachmentProblem, byteRange, cleanAttachmentName, contentDisposition } from "./attachments.js";
import type { OrchestratorEnv, Principal } from "./auth.js";
import { restrictedKey } from "./accounts.js";
import { openSqliteStore } from "./store.js";
import type { TaskRecord } from "./tasks/types.js";
import { createVault } from "./vault.js";

function as(user: Principal): MiddlewareHandler<OrchestratorEnv> {
  return async (c, next) => {
    c.set("user", user);
    await next();
  };
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of the image")]);
const ADA: Principal = { id: "usr_ada", name: "Ada", email: "ada@example.invalid", role: "member", ownedTeams: [] };
const BO: Principal = { id: "usr_bo", name: "Bo", email: "bo@example.invalid", role: "member", ownedTeams: [] };
const OWNER: Principal = { id: "usr_olu", name: "Olu", email: "olu@example.invalid", role: "member", ownedTeams: ["Payments"] };

let dir: string;
let ctx: OrchestratorContext;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "th-attachments-"));
  ctx = { store: openSqliteStore(":memory:"), dataDir: dir, tenant: "acme", vault: createVault(Buffer.alloc(32, 3)) };
  const task: TaskRecord = { tenant: "acme", id: "tsk_a", repoId: "payments-skills", team: "Payments", title: "t", description: "", issueUrl: null, issueKey: null, agent: "fake", status: "running", createdBy: ADA.email, createdAt: new Date().toISOString(), startedAt: null, finishedAt: null, baseSha: null, tests: null, cost: { usd: null, inputTokens: null, outputTokens: null }, requestNumber: null, error: null };
  await ctx.store.createTask(task);
  for (const p of [ADA, BO, OWNER]) await ctx.store.insertUser({ tenant: "acme", id: p.id, email: p.email, name: p.name, role: p.role, passwordHash: null, oidcIssuer: null, oidcSubject: null, forgeLogin: null, createdAt: new Date().toISOString() });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const upload = (user: Principal, bytes: Buffer, mime: string, name = "screen.png") =>
  createApp(ctx, as(user)).request("/api/tasks/tsk_a/attachments", { method: "POST", body: new Uint8Array(bytes), headers: { "content-type": mime, "x-attachment-name": encodeURIComponent(name) } });

describe("what a task takes as an attachment", () => {
  it("given files of each kind, ones that lie about their type, text that is not UTF-8, JSON that does not parse and text holding a token, when each is checked, then only the honest ones are taken", () => {
    expect(attachmentProblem("image/png", PNG)).toBeNull();
    expect(attachmentProblem("application/json", Buffer.from('{"a":1}'))).toBeNull();
    expect(attachmentProblem("image/png", Buffer.from("<html>"))).toMatch(/does not start the way/);
    expect(attachmentProblem("text/html", Buffer.from("<html>"))).toMatch(/is none of them/);
    expect(attachmentProblem("text/plain", Buffer.from([0xff, 0xfe, 0x00]))).toMatch(/UTF-8/);
    expect(attachmentProblem("application/json", Buffer.from("{nope"))).toMatch(/parses/);
    expect(attachmentProblem("text/plain", Buffer.from(`token ghp_${"a".repeat(36)}`))).toMatch(/looks like a/);
    expect(attachmentProblem("text/plain", Buffer.alloc(0))).toMatch(/empty/);
  });

  it("given names with folders, control characters and quotes, when they are cleaned and put in a download header, then no path, CR, LF or quote is left and the exact name travels encoded", () => {
    expect(cleanAttachmentName('../../etc/"pass\r\nwd"')).toBe("passwd");
    expect(contentDisposition("résumé.png")).toBe(`attachment; filename="r_sum_.png"; filename*=UTF-8''r%C3%A9sum%C3%A9.png`);
  });

  it("given Range headers inside, past and across the end of a file, when they are read, then only ranges within it are served", () => {
    expect([byteRange(undefined, 10), byteRange("bytes=2-5", 10), byteRange("bytes=-3", 10), byteRange("bytes=8-", 10)]).toEqual([null, { start: 2, end: 5 }, { start: 7, end: 9 }, { start: 8, end: 9 }]);
    expect([byteRange("bytes=10-12", 10), byteRange("bytes=5-2", 10), byteRange("items=0-1", 10), byteRange("bytes=-", 10)]).toEqual(["unsatisfiable", "unsatisfiable", "unsatisfiable", "unsatisfiable"]);
  });
});

describe("a task's attachments over HTTP", () => {
  it("given the task's starter, a member who does not see it and the team's owner, when each uploads, then the starter's and the owner's are kept in the data directory for the orchestrator's user alone and the stranger is told there is no such task", async () => {
    // when
    const byStarter = await upload(ADA, PNG, "image/png");
    const byStranger = await upload(BO, PNG, "image/png");
    const byOwner = await upload(OWNER, Buffer.from("notes"), "text/plain", "notes.txt");

    // then
    expect([byStarter.status, byStranger.status, byOwner.status]).toEqual([201, 404, 201]);
    const { attachment } = (await byStarter.json()) as { attachment: { id: string; name: string } };
    expect(attachment.name).toBe("screen.png");
    expect(statSync(attachmentPath(dir, "acme", attachment.id)).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "attachments", "acme")).mode & 0o777).toBe(0o700);
  });

  it("given an attachment, when its starter asks for its address and fetches it, then it comes back with the headers that keep a browser from running it, a range is honoured, and a forged, expired, changed or orphaned address is unknown", async () => {
    // given
    const { attachment } = (await (await upload(ADA, PNG, "image/png", "shot.png")).json()) as { attachment: { id: string } };
    const app = createApp(ctx, as(ADA));

    // when
    const { url } = (await (await app.request(`/api/tasks/tsk_a/attachments/${attachment.id}/url`)).json()) as { url: string };
    const served = await app.request(url);
    const part = await app.request(url, { headers: { range: "bytes=0-3" } });
    const forged = await app.request(url.replace(/sig=[^&]+/, "sig=" + "A".repeat(43)));
    const otherPerson = await app.request(url.replace("u=usr_ada", "u=usr_bo"));
    const expired = await app.request(url.replace(/exp=\d+/, `exp=${Date.now() - 1}`));

    // then
    expect(served.status).toBe(200);
    expect(Buffer.from(await served.arrayBuffer()).equals(PNG)).toBe(true);
    expect(Object.fromEntries(["content-security-policy", "referrer-policy", "x-content-type-options", "cache-control", "content-disposition"].map((h) => [h, served.headers.get(h)]))).toEqual({
      "content-security-policy": "default-src 'none'; sandbox",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "content-disposition": `attachment; filename="shot.png"; filename*=UTF-8''shot.png`,
    });
    expect([part.status, part.headers.get("content-range")]).toEqual([206, `bytes 0-3/${PNG.length}`]);
    expect([forged.status, otherPerson.status, expired.status]).toEqual([404, 404, 404]);

    // and when the file changes on disk, or its person leaves the organization
    writeFileSync(attachmentPath(dir, "acme", attachment.id), PNG.subarray(0, 4));
    expect((await app.request(url)).status).toBe(404);
    writeFileSync(attachmentPath(dir, "acme", attachment.id), PNG);
    expect((await app.request(url)).status).toBe(200);
    await ctx.store.setSetting("acme", `scim.off.${ADA.id}`, "2026-11-03T00:00:00.000Z");
    expect((await app.request(url)).status).toBe(404);
    await ctx.store.deleteSetting("acme", `scim.off.${ADA.id}`);
    expect((await app.request(url)).status).toBe(200);
    await ctx.store.deleteUser("acme", ADA.id);
    expect((await app.request(url)).status).toBe(404);
  });

  it("given a restricted team's owner's address, when they stop owning the team, then the address stops working since they no longer read its tasks", async () => {
    // given
    const { attachment } = (await (await upload(ADA, PNG, "image/png")).json()) as { attachment: { id: string } };
    await ctx.store.setSetting("acme", restrictedKey("Payments"), "1");
    await ctx.store.setOwnedTeams("acme", OWNER.id, ["Payments"]);
    const { url } = (await (await createApp(ctx, as(OWNER)).request(`/api/tasks/tsk_a/attachments/${attachment.id}/url`)).json()) as { url: string };
    expect((await createApp(ctx, as(OWNER)).request(url)).status).toBe(200);

    // when
    await ctx.store.setOwnedTeams("acme", OWNER.id, []);

    // then
    expect((await createApp(ctx, as(OWNER)).request(url)).status).toBe(404);
  });

  it("given an upload streamed without a length and past the limit, when it is sent, then it is refused as too large", async () => {
    const big = new ReadableStream<Uint8Array>({ start(controller) { for (let i = 0; i < 11; i += 1) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close(); } });
    const res = await createApp(ctx, as(ADA)).request("/api/tasks/tsk_a/attachments", { method: "POST", body: big, headers: { "content-type": "image/png" }, duplex: "half" } as RequestInit);
    expect(res.status).toBe(413);
    expect(await ctx.store.taskAttachments("acme", "tsk_a")).toEqual([]);
  });

  it("given a task at its limit, when one more is uploaded, then it is refused and no file is left behind", async () => {
    for (let i = 0; i < 20; i += 1) expect((await upload(ADA, PNG, "image/png", `s${i}.png`)).status).toBe(201);
    const over = await upload(ADA, PNG, "image/png", "one-more.png");
    expect(over.status).toBe(409);
    expect(await ctx.store.taskAttachments("acme", "tsk_a")).toHaveLength(20);
  });
});
