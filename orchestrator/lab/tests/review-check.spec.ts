import { createHmac } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { ForgeStatus } from "../forge.js";
import { labGit } from "../run.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, lab, ownerOf, SHAPES, teammateShare, unique, whileChanged, withdrawShare } from "./support.js";

const RULES = ".teamhandbook/review-rules.md";
const CONTEXT = "teamhandbook/review-rules";
const UNDECIDED = "The review did not end in PASS or FAIL, so the change is not passed.";

/** A forge telling the orchestrator a request opened or moved, signed the way that forge signs its deliveries. */
async function deliver(org: LabOrg, repo: LabRepo, number: number, sha: string, base: string, secret = org.hookSecret!, action = "open"): Promise<{ status: number; body: Record<string, unknown> }> {
  const gitlab = repo.forge === "gitlab";
  const body = JSON.stringify(
    gitlab
      ? { object_kind: "merge_request", object_attributes: { iid: number, action, last_commit: { id: sha }, target_branch: base } }
      : { action: action === "open" ? "opened" : "synchronize", pull_request: { number, head: { sha }, base: { ref: base } } },
  );
  const headers: Record<string, string> = gitlab
    ? { "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": secret }
    : { "x-github-event": "pull_request", "x-hub-signature-256": `sha256=${createHmac("sha256", secret).update(body).digest("hex")}` };
  const res = await fetch(`${org.url}/api/hooks/forge/${repo.id}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

/** The statuses the orchestrator wrote on `sha`, once it wrote a final one. */
async function statusesOn(repo: LabRepo, sha: string): Promise<ForgeStatus[]> {
  const forge = lab.forges.find((f) => f.kind === repo.forge)!;
  for (let i = 0; i < 120; i++) {
    const { statuses } = (await (await fetch(`${forge.url}/lab/statuses`)).json()) as { statuses: ForgeStatus[] };
    const on = statuses.filter((s) => s.sha === sha);
    if (on.some((s) => s.state !== "pending")) return on;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`no final status on ${sha}`);
}

const github = lab.orgs.filter((o) => !o.extra).flatMap((org) => org.repos.filter((r) => r.forge === "github").map((repo) => ({ shape: "on GitHub", org, repo }))).slice(0, 1);
const hosted = [...SHAPES.filter((s) => s.repo.forge !== "local"), ...github];

test.describe("the team's review rules as a check on each request", () => {
  for (const { shape, org, repo } of hosted) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner turns the review check on and the forge announces a teammate's request, then a wrongly signed delivery is refused, the orchestrator writes a pending and then a final status on the request's head, a repeated delivery is not reviewed again, a member cannot turn it on, and once off a delivery is ignored`, async () => {
      test.setTimeout(240_000);
      // given
      const owner = await ownerOf(org, repo);
      const byMember = await (await as(org, "member")).call<{ error?: string }>("PUT", `/api/repos/${repo.id}/review-check`, { agent: "fake" });
      await owner.ok("PUT", `/api/repos/${repo.id}/review-check`, { agent: "fake" });
      const base = labGit(lab.path, ["symbolic-ref", "--short", "HEAD"], repo.bare);
      try {
        await whileChanged(org, repo, { [RULES]: "# Review rules\n\n1. Every skill says when to use it.\n" }, async () => {
          const slug = unique("reviewed-skill");
          const share = await teammateShare(repo, "nora", { [`skills/${slug}/SKILL.md`]: `---\nname: ${slug}\ndescription: Use when the lab checks a review.\n---\n\nBody.\n` }, `Add ${slug}`);
          const sha = labGit(lab.path, ["rev-parse", `refs/heads/${share.branch}`], repo.bare);
          try {
            // when
            const forged = await deliver(org, repo, share.number!, sha, base, "not-the-hook-secret-at-all");
            const queued = await deliver(org, repo, share.number!, sha, base);
            const written = await statusesOn(repo, sha);
            const again = await deliver(org, repo, share.number!, sha, base);

            // then
            expect([byMember.status, byMember.json.error]).toEqual([403, `only an admin or an owner of ${repo.team} sets this repository's review check`]);
            expect([forged.status, forged.body.error]).toEqual([401, "the delivery's signature does not hold"]);
            expect([queued.status, queued.body]).toEqual([202, { review: "queued" }]);
            expect(written[0]).toMatchObject({ state: "pending", name: CONTEXT, description: "Reviewing the change against the team's review rules." });
            expect(written.at(-1)).toMatchObject({ state: repo.forge === "gitlab" ? "failed" : "error", name: CONTEXT, description: UNDECIDED });
            expect([again.status, again.body]).toEqual([200, { ignored: "this commit of the request was already reviewed" }]);
            const { events } = await (await as(org, "org-admin")).ok<{ events: { kind: string; subject: string; detail: string }[] }>("GET", "/api/events?kind=review.check");
            expect(events.find((e) => e.kind === "review.check.ran" && e.subject === `request:${share.number}@${sha}`)?.detail).toContain(UNDECIDED);
          } finally {
            await withdrawShare(repo, share);
          }
        });
      } finally {
        await owner.ok("DELETE", `/api/repos/${repo.id}/review-check`);
      }

      // when the check is off, then a delivery is ignored
      const off = await deliver(org, repo, 999, "0".repeat(40), base, org.hookSecret!, "update");
      expect([off.status, off.body]).toEqual([200, { ignored: `the review check is off for ${repo.id}` }]);
    });
  }

  for (const { shape, org, repo } of SHAPES.filter((s) => s.repo.forge === "local")) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner turns the review check on, then it is refused, since a repository with no forge access has nowhere to write a check`, async () => {
      // when
      const turned = await (await ownerOf(org, repo)).call<{ error?: string }>("PUT", `/api/repos/${repo.id}/review-check`, { agent: "fake" });

      // then
      expect([turned.status, turned.json.error]).toEqual([409, `${repo.id} has no GitHub or GitLab access set, so a check has nowhere to be written`]);
    });
  }
});
