import { expect, test } from "@playwright/test";
import type { OrchestratorClient } from "../client.js";
import type { LabOrg, LabRepo } from "../state.js";
import { close, needsTicket, ownerOf, SHAPES, unique } from "./support.js";

interface Sent {
  event: string;
  id: string | null;
  data: string;
}

/** Every event a task's stream sends until the orchestrator ends it, read as a page's EventSource would. */
async function follow(org: LabOrg, client: OrchestratorClient, id: string, lastEventId?: string): Promise<Sent[]> {
  const res = await fetch(`${org.url}/api/tasks/${id}/events`, { headers: { cookie: client.cookie, ...(lastEventId ? { "last-event-id": lastEventId } : {}) } });
  expect(res.headers.get("content-type")).toContain("text/event-stream");
  const sent: Sent[] = [];
  for (const block of (await res.text()).split("\n\n")) {
    const fields = block.split("\n").filter((l) => l && !l.startsWith(":"));
    if (!fields.length) continue;
    const field = (name: string) => fields.filter((l) => l.startsWith(`${name}:`)).map((l) => l.slice(name.length + 1).trimStart());
    sent.push({ event: field("event")[0] ?? "message", id: field("id")[0] ?? null, data: field("data").join("\n") });
  }
  return sent;
}

const linesOf = (sent: Sent[]) => sent.filter((s) => s.event === "log").flatMap((s) => (JSON.parse(s.data) as { log: { seq: number; text: string }[] }).log);

async function start(owner: OrchestratorClient, repo: LabRepo, description: string): Promise<string> {
  const key = /^([A-Z][A-Z0-9]*)-/.exec(repo.branchExample ?? "")?.[1];
  const issue = needsTicket(repo) ? { issueUrl: `https://tracker.example.invalid/browse/${key}-${100 + Math.floor(Math.random() * 900)}` } : {};
  return (await owner.ok<{ task: { id: string } }>("POST", "/api/tasks", { title: unique("Lab streamed task"), description, repoId: repo.id, agent: "fake", ...issue })).task.id;
}

test.describe("a task's log as a stream", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner follows a running task, then every line arrives once and in order with the task's end, a page that comes back resumes after the last line it saw, and nobody signed out follows it`, async () => {
      test.setTimeout(120_000);
      // given
      const owner = await ownerOf(org, repo);
      const id = await start(owner, repo, "Add a skill named after this task.\nstand-in: wait 2 seconds\nstand-in: print 40 lines");

      // when
      const sent = await follow(org, owner, id);
      const firstLog = sent.find((s) => s.event === "log")!;
      const resumed = await follow(org, owner, id, firstLog.id!);
      const signedOut = await fetch(`${org.url}/api/tasks/${id}/events`);
      const unknown = await owner.call("GET", "/api/tasks/000000000000/events");
      const { log, task } = await owner.ok<{ log: { seq: number; text: string }[]; task: { status: string; requestNumber: number | null } }>("GET", `/api/tasks/${id}`);

      try {
        // then
        expect(sent[0]?.event).toBe("connected");
        const lines = linesOf(sent);
        expect(lines.map((l) => l.seq)).toEqual(log.map((l) => l.seq));
        expect(lines.map((l) => l.seq)).toEqual([...lines.map((l) => l.seq)].sort((a, b) => a - b));
        for (let n = 1; n <= 40; n++) expect(lines.filter((l) => l.text === `line ${n} of 40`)).toHaveLength(1);
        expect(JSON.parse(sent.filter((s) => s.event === "task").at(-1)!.data).status).toBe("needs-review");
        expect(linesOf(resumed).map((l) => l.seq)).toEqual(log.filter((l) => l.seq > Number(firstLog.id)).map((l) => l.seq));
        expect([signedOut.status, unknown.status]).toEqual([401, 404]);
      } finally {
        if (task.requestNumber) await close(org, repo, task.requestNumber);
      }
    });
  }
});
