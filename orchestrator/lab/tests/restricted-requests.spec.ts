import { expect, test } from "@playwright/test";
import type { OrchestratorClient } from "../client.js";
import { ownerKey } from "../state.js";
import { as, close, lab, runToReview, unique } from "./support.js";

const org = lab.orgs.find((o) => o.name === "globex");
const repo = org?.repos.find((r) => r.id === "data-skills");
/** An image's address as GitLab writes it into a request's description. */
const UPLOAD = "/uploads/0123456789abcdef0123456789abcdef/screen.png";

/**
 * A request a task of a team kept to its owners opened is that team's: someone outside it is
 * answered as if it did not exist, on every route that reads it, and the person who started the
 * task reads all of it. The Data team on the stand-in GitLab is kept to its owners for the
 * scenario and opened again after it; its owner starts the task, the Infra team's owner is outside.
 */
test.describe("a request of a team kept to its owners", () => {
  test.skip(!org || !repo, "this lab has no organization on the stand-in GitLab");

  async function restrictedRequest(): Promise<{ starter: OrchestratorClient; outsider: OrchestratorClient; number: number; done: () => Promise<void> }> {
    const admin = await as(org!, "org-admin");
    const starter = await as(org!, ownerKey("Data"));
    const outsider = await as(org!, ownerKey("Infra"));
    // The team is opened again whatever happens after it is kept to its owners: the specs after this one read it open.
    const reopen = () => admin.ok("PUT", "/api/teams/Data/restricted", { restricted: false });
    await starter.ok("PUT", "/api/teams/Data/restricted", { restricted: true });
    try {
      const task = await runToReview(starter, repo!, unique("Lab task of a team kept to its owners"));
      const shown = await starter.ok<{ task: { requestNumber: number | null } }>("GET", `/api/tasks/${task.id}`);
      const number = shown.task.requestNumber;
      if (task.status !== "needs-review" || number === null) throw new Error(`the task did not open a request: ${task.status} ${task.error}`);
      return {
        starter,
        outsider,
        number,
        done: async () => {
          try {
            await close(org!, repo!, number);
          } finally {
            await reopen();
          }
        },
      };
    } catch (err) {
      await reopen();
      throw err;
    }
  }

  const base = () => `/api/repos/${repo!.id}`;

  /** The files the request changes, once the orchestrator's copy of the repository holds its branch: the `files` of its `changes`. */
  async function changesOf(starter: OrchestratorClient, number: number): Promise<{ path: string }[]> {
    for (let i = 0; i < 120; i++) {
      const { changes } = await starter.ok<{ changes: { files: { path: string }[] } }>("GET", `${base()}/requests/${number}/changes`);
      if (changes.files.length) return changes.files;
      await starter.call("POST", `/api/repos/${repo!.id}/sync`);
      await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`request ${number} lists no changed file`);
  }
  const media = () => `${base()}/media?src=${encodeURIComponent(UPLOAD)}`;
  /** Whether the request is on any page of the list this person reads, following each page's `next`: a busy lab's request is past the first. */
  async function listed(who: OrchestratorClient, number: number): Promise<boolean> {
    for (let after: string | null = ""; after !== null; ) {
      const page: { requests: { repoId: string; number: number }[]; next: string | null } = await who.ok("GET", `/api/requests?repo=${repo!.id}${after ? `&after=${after}` : ""}`);
      if (page.requests.some((r) => r.repoId === repo!.id && r.number === number)) return true;
      after = page.next;
    }
    return false;
  }

  // What the two scenarios after it take for granted, so a broken setup is red here rather than an expected failure there.
  test("given a request a task of the Data team opened while the team is kept to its owners, when the task's starter reads it, then its changes, one changed file, its status and its description answer, an image its description names is looked for, and it is in the list", async () => {
    test.setTimeout(240_000);
    // given
    const { starter, number, done } = await restrictedRequest();
    try {
      // when
      const changes = await changesOf(starter, number);
      const reads = [`${base()}/requests/${number}/changes/${changes[0]!.path}`, `${base()}/requests/${number}/status`, `${base()}/requests/${number}/description`];
      const answered = await Promise.all(reads.map((path) => starter.call("GET", path)));
      const image = await starter.call<{ error?: string }>("GET", media());

      // then
      expect(answered.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(image.json.error).not.toBe("unknown repository");
      expect(await listed(starter, number)).toBe(true);
    } finally {
      await done();
    }
  });

  test("given a request a task of the Data team opened while the team is kept to its owners, when the Infra team's owner reads its changes, one changed file, its status and an image its description names, then each answers as if the request did not exist", async () => {
    test.setTimeout(240_000);
    // given
    const { starter, outsider, number, done } = await restrictedRequest();
    try {
      const changes = await changesOf(starter, number);

      // when
      const reads = [`${base()}/requests/${number}/changes`, `${base()}/requests/${number}/changes/${changes[0]!.path}`, `${base()}/requests/${number}/status`];
      const byOutsider = await Promise.all(reads.map((path) => outsider.call("GET", path)));
      const image = await outsider.call<{ error?: string }>("GET", media());

      // then
      expect(byOutsider.map((r) => r.status)).toEqual([404, 404, 404]);
      expect([image.status, image.json.error]).toEqual([404, "unknown repository"]);
    } finally {
      await done();
    }
  });

  test("given a request a task of the Data team opened while the team is kept to its owners, when the Infra team's owner lists the requests and reads its description, then it is not in the list and its description answers as if it did not exist", async () => {
    test.setTimeout(240_000);
    // given
    const { outsider, number, done } = await restrictedRequest();
    try {
      // when
      const inList = await listed(outsider, number);
      const description = await outsider.call("GET", `${base()}/requests/${number}/description`);

      // then
      expect([inList, description.status]).toEqual([false, 404]);
    } finally {
      await done();
    }
  });
});
