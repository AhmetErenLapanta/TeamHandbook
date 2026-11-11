import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoRecord } from "../store.js";
import { CassetteRefused, readCassette, recordingProxy, replayServer, writeCassette } from "./cassette.js";
import { createGitLabForge } from "./gitlab.js";
import type { ChangeRequest } from "./types.js";

const TOKEN = "plain-forge-token-0123456789";
const BASE = "a".repeat(40);
const PROJECT = "/api/v4/projects/acme%2Fpayments-skills";
const REPO = { id: "payments-skills", name: "payments-skills" } as RepoRecord;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** A stand-in for a GitLab: the orchestrator's tests never reach a real forge. `echo` puts the caller's token into an answer, as some error pages do. */
async function standInGitLab(echo = false): Promise<string> {
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const send = (status: number, body: unknown) => {
        res.statusCode = status;
        res.setHeader("content-type", "application/json");
        res.setHeader("x-request-id", "req-1");
        res.end(JSON.stringify(body));
      };
      const at = `${req.method} ${req.url}`;
      if (at === `GET ${PROJECT}`) return send(200, { id: 7, default_branch: "main" });
      if (at === `GET ${PROJECT}/repository/files/README.md?ref=${BASE}`) return send(200, { file_path: "README.md" });
      if (at === `POST ${PROJECT}/repository/commits`) return send(201, { id: "c0ffee".padEnd(40, "0") });
      if (at === `POST ${PROJECT}/merge_requests`) return send(201, { iid: 42, web_url: "https://gitlab.example.invalid/acme/payments-skills/-/merge_requests/42", state: "opened", ...(echo ? { note: `opened with ${req.headers["private-token"] ?? req.headers.authorization}` } : {}) });
      if (at === `GET ${PROJECT}/merge_requests/42`) return send(200, { iid: 42, web_url: "", state: "merged", merged_at: "2026-10-20T07:30:00Z" });
      return send(404, { message: "404 Not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const change: ChangeRequest = {
  title: "feat(skill): add on-call-handover",
  body: "Proposed from the orchestrator.",
  branch: "handbook/on-call-handover",
  baseSha: BASE,
  files: [
    { path: "skills/on-call-handover/SKILL.md", content: "---\nname: on-call-handover\n---\n" },
    { path: "README.md", content: "updated\n" },
  ],
  author: { name: "Ada Example", email: "ada@example.invalid" },
} as ChangeRequest;

const forgeAt = (url: string) => createGitLabForge({ repoId: "payments-skills", kind: "gitlab", apiUrl: `${url}/api/v4`, project: "acme/payments-skills" }, TOKEN);

async function record(name: string, echo = false) {
  const proxy = await recordingProxy(name, await standInGitLab(echo));
  cleanups.push(proxy.stop);
  const forge = forgeAt(proxy.url);
  const opened = await forge.open(REPO, change);
  const state = await forge.status!(REPO, opened.number);
  return { cassette: proxy.cassette, opened, state };
}

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "orchestrator-cassette-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("forge cassettes", () => {
  it("given a conversation recorded through the proxy, when it is written and played back with the forge gone, then the orchestrator gets the same answers, every one is used, and no credential or caller header is on disk", async () => {
    // given
    const recorded = await record("gitlab-open-and-merge");
    const file = join(scratch(), "gitlab-open-and-merge.json");
    writeCassette(file, recorded.cassette, [TOKEN]);

    // when
    const replay = await replayServer(readCassette(file));
    cleanups.push(replay.stop);
    const forge = forgeAt(replay.url);
    const opened = await forge.open(REPO, change);
    const state = await forge.status!(REPO, opened.number);

    // then
    expect(opened).toEqual(recorded.opened);
    expect(state).toEqual({ status: "merged", mergedAt: "2026-10-20T07:30:00.000Z" });
    expect(replay.misses).toEqual([]);
    expect(replay.left()).toBe(0);
    const text = readFileSync(file, "utf8");
    expect(text).not.toContain(TOKEN);
    expect(text.toLowerCase()).not.toMatch(/private-token|authorization|x-request-id/);
  });

  it("given a forge that echoed the token into an answer, when the cassette is written, then it is refused and nothing reaches disk", async () => {
    // given
    const recorded = await record("gitlab-echo", true);
    const file = join(scratch(), "gitlab-echo.json");

    // when
    const write = () => writeCassette(file, recorded.cassette, [TOKEN]);

    // then
    expect(write).toThrow(CassetteRefused);
    expect(write).toThrow("holds the token it was recorded with");
    expect(existsSync(file)).toBe(false);
  });

  it("given a cassette carrying something shaped like a credential the recording did not use, when it is written, then it is refused", () => {
    // given
    const file = join(scratch(), "leak.json");
    const cassette = { name: "leak", interactions: [{ request: { method: "GET", path: "/x", body: null }, response: { status: 200, contentType: "application/json", body: { key: "ghp_abcdefghijklmnopqrstuvwxyz0123456789" } } }] };

    // when
    const write = () => writeCassette(file, cassette);

    // then
    expect(write).toThrow(/looks like a/);
    expect(existsSync(file)).toBe(false);
  });

  it("given a cassette played back to a client that asks something it did not record, when the client runs, then the request is named as a miss", async () => {
    // given
    const { cassette } = await record("gitlab-open-and-merge");
    const replay = await replayServer({ ...cassette, interactions: cassette.interactions.filter((i) => i.request.method === "GET" && i.request.path === PROJECT) });
    cleanups.push(replay.stop);

    // when
    const attempt = forgeAt(replay.url).open(REPO, change);

    // then
    await expect(attempt).rejects.toThrow();
    expect(replay.misses.length).toBeGreaterThan(0);
  });
});
