import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { ownerKey, userOf } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, lab, merge, ownerOf, propose, SHAPES, startTenantOrchestrator, unique } from "./support.js";

interface Event {
  at: string;
  kind: string;
  actor: { kind: string; email: string | null };
  repoId: string | null;
  subject: string | null;
  detail: string;
}

async function events(org: LabOrg, query = ""): Promise<Event[]> {
  return (await (await as(org, "org-admin")).ok<{ events: Event[] }>("GET", `/api/events${query}`)).events;
}

const skillText = (slug: string) => `---\nname: ${slug}\ndescription: Use when the lab checks the event log.\n---\n\nBody.\n`;

/** The four shapes, and the repositories of any organization added from outside the lab. */
const CASES: { shape: string; org: LabOrg; repo: LabRepo }[] = [
  ...SHAPES,
  ...lab.orgs.filter((o) => o.extra).flatMap((org, i) => org.repos.map((repo) => ({ shape: `in extra organization ${i + 1}`, org, repo }))),
];

test.describe("the orchestrator's event log", () => {
  for (const { shape, org, repo } of CASES) {
    test(`given ${org.extra ? "a repository" : `${org.name}'s ${repo.id}`}, ${shape}, when its owner opens a request and it is merged, then the log names both, who opened it and the repository, newest first, and its export carries them`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = unique("logged");
      const since = new Date().toISOString();

      // when
      const opened = await propose(owner, org, repo, { kind: "skill.add", slug, content: skillText(slug) }, `add ${slug}`);
      expect(opened.status, opened.error).toBe(200);
      await merge(org, repo, opened.request!.number);

      // then
      const logged = (await events(org, `?repo=${repo.id}&kind=request`)).filter((e) => e.at >= since);
      expect(logged.map((e) => e.kind)).toEqual(["request.merged", "request.opened"]);
      const [merged, open] = logged as [Event, Event];
      expect(open).toMatchObject({ repoId: repo.id, actor: { kind: "user", email: userOf(org, ownerKey(repo.team)).email } });
      expect(open.subject).toBe(`request:${opened.request!.number}`);
      expect(merged.subject).toBe(`request:${opened.request!.number}`);
      expect(merged.repoId).toBe(repo.id);

      // and the export
      const admin = await as(org, "org-admin");
      const csv = await fetch(`${org.url}/api/events/export?format=csv&repo=${repo.id}&kind=request`, { headers: { cookie: admin.cookie } });
      expect(csv.headers.get("content-type")).toContain("text/csv");
      // CSV ends its rows with CRLF, as RFC 4180 has it.
      const lines = (await csv.text()).trim().split(/\r?\n/);
      expect(lines[0]).toBe("at,kind,actor_kind,actor_name,actor_email,repo,subject,detail");
      // Every field is quoted, so a value a spreadsheet would read as a formula stays text.
      expect(lines.filter((l) => l.includes(`,"request:${opened.request!.number}",`)).length).toBe(2);
      const jsonl = await fetch(`${org.url}/api/events/export?format=jsonl&repo=${repo.id}&kind=request`, { headers: { cookie: admin.cookie } });
      const rows = (await jsonl.text()).trim().split("\n").map((l) => JSON.parse(l) as { kind: string; repo: string });
      expect(rows.every((r) => r.repo === repo.id && r.kind.startsWith("request"))).toBe(true);
      expect((await events(org, "?kind=events.exported")).filter((e) => e.at >= since).length).toBe(2);
    });
  }

  for (const org of lab.orgs.filter((o) => !o.extra)) {
    test(`given ${org.name}, when a member, a team's owner among them, asks for the log, its export or its retention, then each is refused`, async () => {
      for (const user of org.users.filter((u) => u.role === "member")) {
        // given
        const client = await as(org, user.key);

        // when
        const read = await client.call("GET", "/api/events");
        const exported = await client.call("GET", "/api/events/export?format=jsonl");
        const kept = await client.call("PUT", "/api/events/retention", { days: 1 });

        // then
        expect([user.key, read.status, exported.status, kept.status]).toEqual([user.key, 403, 403, 403]);
      }
    });
  }

  for (const org of lab.orgs.filter((o) => !o.extra)) {
    test(`given ${org.name}, when its owner reads the log, then the owner is answered as its admins are`, async () => {
      // when
      const reply = await (await as(org, "admin")).call("GET", "/api/events");

      // then
      expect(reply.status).toBe(200);
    });
  }

  test("given a second tenant's orchestrator on the shared Postgres, when each admin reads its log, then neither sees the other's sign-ins or setup", async () => {
    // given
    const org = lab.orgs.find((o) => o.store === "postgres" && !o.extra)!;
    const shadow = await startTenantOrchestrator(1);
    try {
      await OrchestratorClient.signIn(org.url, userOf(org, "admin").email, lab.password);

      const reader = { email: `reader@${shadow.tenant}.example.invalid`, name: "Shadow Reader" };
      await shadow.admin.ok("POST", "/api/users", { ...reader, role: "admin", teams: [], password: lab.password });
      const theirAdmin = await OrchestratorClient.signIn(shadow.url, reader.email, lab.password);

      // when
      const ours = await events(org);
      const theirs = (await theirAdmin.ok<{ events: Event[] }>("GET", "/api/events")).events;

      // then
      expect(theirs.map((e) => e.kind)).toEqual(expect.arrayContaining(["orchestrator.setup"]));
      expect(theirs.every((e) => !e.actor.email || e.actor.email.endsWith(`@${shadow.tenant}.example.invalid`))).toBe(true);
      expect(ours.some((e) => e.actor.email?.endsWith(`@${shadow.tenant}.example.invalid`))).toBe(false);
    } finally {
      shadow.stop();
    }
  });
});
