import { expect, test } from "@playwright/test";
import { OrchestratorClient } from "../client.js";
import { as, lab, SHAPES, unique } from "./support.js";

interface Summary {
  email: string;
  role: string;
  ownedTeams: string[];
  activeKeys: number;
  blocked: string | null;
}

test.describe("a person's own account", () => {
  for (const { org, repo } of SHAPES.filter((s, i) => SHAPES.findIndex((t) => t.org === s.org) === i)) {
    test(`given ${org.name}, when a member who owns ${repo.team} renames themselves and then deletes their account after its summary, then the summary names their team and key, a wrong address is refused, their session and key stop working, they cannot sign in, and both changes are logged, while the only owner is kept`, async () => {
      // given
      const owner = await as(org, "admin");
      const email = `${unique("leaving")}@${org.name}.example.invalid`;
      await owner.ok("POST", "/api/users", { email, name: "Leaving Member", role: "member", teams: [repo.team], password: lab.password });
      const person = await OrchestratorClient.signIn(org.url, email, lab.password);
      const { secret } = await person.ok<{ secret: string }>("POST", "/api/keys", { name: unique("leaving-key"), scopes: { repositories: "read" }, expiresInDays: 1 });
      const key = OrchestratorClient.withKey(org.url, secret);

      // when
      const renamedByKey = await key.call<{ error?: string }>("PATCH", "/api/me", { name: "Through A Key" });
      const renamed = await person.ok<{ user: { name: string } }>("PATCH", "/api/me", { name: "Renamed Member" });
      const { summary } = await person.ok<{ summary: Summary }>("GET", "/api/me/deletion");
      const wrong = await person.call<{ error?: string }>("POST", "/api/me/deletion", { confirm: `someone-else@${org.name}.example.invalid` });
      const deleted = await person.call<{ ok?: boolean }>("POST", "/api/me/deletion", { confirm: email });

      // then
      expect([renamedByKey.status, renamedByKey.json.error]).toEqual([403, "an API key cannot do this; it takes a person signed in to the orchestrator"]);
      expect(renamed.user.name).toBe("Renamed Member");
      expect(summary).toMatchObject({ email, role: "member", ownedTeams: [repo.team], activeKeys: 1, blocked: null });
      expect([wrong.status, wrong.json.error]).toEqual([400, "type your email address to confirm"]);
      expect([deleted.status, deleted.json.ok]).toEqual([200, true]);
      expect((await person.call("GET", "/api/me")).status).toBe(401);
      expect((await key.call("GET", "/api/repos")).status).toBe(401);
      const again = await fetch(`${org.url}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: lab.password }) });
      // Answered as any unknown address is, so a deleted account cannot be told from one that never was.
      expect([again.status, ((await again.json()) as { error?: string }).error]).toEqual([403, "wrong email or password"]);
      const { events } = await owner.ok<{ events: { kind: string; detail: string }[] }>("GET", "/api/events?kind=account");
      expect(events.map((e) => [e.kind, e.detail])).toEqual(
        expect.arrayContaining([
          ["account.changed", `${email}: name Renamed Member`],
          ["account.deleted", `${email} deleted their own account, which was member owning ${repo.team}, with 1 active key`],
        ]),
      );

      // when the organization's only owner asks the same
      const { summary: theirs } = await owner.ok<{ summary: Summary }>("GET", "/api/me/deletion");
      const kept = await owner.call<{ error?: string }>("POST", "/api/me/deletion", { confirm: theirs.email });

      // then
      expect(theirs.blocked).toBe("you are the only owner here; make another member an owner first");
      expect([kept.status, kept.json.error]).toEqual([409, "you are the only owner here; make another member an owner first"]);
      expect((await owner.call("GET", "/api/me")).status).toBe(200);
    });
  }
});
