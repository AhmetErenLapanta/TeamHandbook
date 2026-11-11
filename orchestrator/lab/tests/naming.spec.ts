import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { createMachine, joinTeam, machineOf, teamConfig } from "../machine.js";
import type { LabOrg, LabRepo } from "../state.js";
import { labGit } from "../run.js";
import { as, close, fileAt, lab, merge, ownerOf, pick, propose, runToReview, unique, whileChanged } from "./support.js";


const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;
const teamFile = (repo: LabRepo) => JSON.parse(fileAt(repo, "HEAD", ".teamhandbook.json")!) as { commitPrefix?: string; branchExample?: string };
const naming = (commitPrefix: string, branchExample: string) => ({ kind: "team.naming", commitPrefix, branchExample });
const probe = { kind: "skill.add", slug: "lab-naming-probe", content: "---\nname: lab-naming-probe\ndescription: Use when the lab checks naming.\n---\n\nBody.\n" };

async function namingLine(org: LabOrg, repo: LabRepo): Promise<string | undefined> {
  const { inventory } = await (await as(org, "member")).ok<{ inventory: { setup: { title: string; detail?: string }[] } }>("GET", `/api/repos/${repo.id}/inventory`);
  return inventory.setup.find((f) => f.title === "Changes follow the team's naming")?.detail;
}

const changedPaths = (repo: LabRepo, branch: string) => labGit(lab.path, ["diff", "--name-only", `HEAD...${branch}`], repo.bare).split("\n").filter(Boolean);
const line = (prefix: string, example: string) => `${prefix ? `Commits start with ${prefix}` : "Commits carry no prefix"}; ${example ? `branches are named like ${example}` : "branches carry no team naming"}.`;

const SHAPES = [
  { shape: "versioned by number", ...pick("acme", "payments-skills"), next: { prefix: "PAYMENTS", example: "payments/short-description" } },
  { shape: "versioned by commit", ...pick("acme", "platform-skills"), next: { prefix: "PLAT", example: "platform/short-description" } },
  { shape: "named by ticket key", ...pick("vandelay", "imports-skills"), next: { prefix: "VAN-8", example: "VAN-200-short-description" } },
  { shape: "on master", ...pick("vandelay", "exports-skills"), next: { prefix: "VAN-7", example: "exports/short-description" } },
];

test.describe("the team's naming changed as a request", () => {
  for (const { shape, org, repo, next } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner changes the commit prefix and the example branch and the request is merged, then a new teammate's join, the panel and the orchestrator's next request all use them, until they are put back`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const was = { prefix: repo.commitPrefix ?? "", example: repo.branchExample ?? "" };
      expect(await namingLine(org, repo)).toBe(line(was.prefix, was.example));

      // when
      const opened = await propose(owner, org, repo, naming(next.prefix, next.example), "chore: set how commits and branches are named");

      // then the request itself is still named the way the team names things now
      expect(opened.status, opened.error).toBe(200);
      expect(opened.request!.title).toBe(was.prefix ? `${was.prefix} chore: set how commits and branches are named` : "chore: set how commits and branches are named");
      if (repo.versioning === "number") expect(versionAt(repo, opened.request!.branch)).not.toBe(versionAt(repo, "HEAD"));

      // when a person merges it
      await merge(org, repo, opened.request!.number);

      // then
      try {
        expect(teamFile(repo)).toMatchObject({ commitPrefix: next.prefix, branchExample: next.example });
        expect(await namingLine(org, repo)).toBe(line(next.prefix, next.example));
        const newcomer = machineOf(lab, createMachine(join(org.dir, "devs"), unique("newcomer")));
        const joined = joinTeam(newcomer, repo.url);
        expect(joined.status).toBe(0);
        expect(joined.stdout).toContain(`commits: titled "${next.prefix} ...", the prefix this repository records`);
        expect(joined.stdout).toContain(`branches: proposed in the shape of "${next.example}"`);
        expect(teamConfig(newcomer)).toMatchObject({ commitPrefix: next.prefix, branchExample: next.example });
        const proposal = await owner.ok<{ proposal: string; branch: string }>("POST", `/api/repos/${repo.id}/changes/proposal`, { change: probe });
        expect(proposal.proposal.startsWith(`${next.prefix} `)).toBe(true);
        // The plugin's order: a ticket key in the commit prefix first, then the example's folder.
        const lead = /^[A-Z][A-Z0-9]+-\d+$/.test(next.prefix) ? `${next.prefix}-` : next.example.slice(0, next.example.lastIndexOf("/") + 1);
        expect(proposal.branch.startsWith(lead)).toBe(true);
      } finally {
        // put back, so the specs after this one read the naming the lab set up
        const back = await propose(owner, org, repo, naming(was.prefix, was.example), "chore: put the naming back");
        expect(back.status, back.error).toBe(200);
        expect(back.request!.title.startsWith(`${next.prefix} `)).toBe(true);
        await merge(org, repo, back.request!.number);
      }
      expect(await namingLine(org, repo)).toBe(line(was.prefix, was.example));
      if (!was.example) expect(teamFile(repo)).not.toHaveProperty("branchExample");
    });
  }

  test("given a repository that runs the version-bump CI job, when its owner changes the commit prefix, then it is refused naming the job's built-in prefix, while a new example branch alone opens", async () => {
    // given
    const { org, repo } = pick("vandelay", "release-skills");
    const owner = await ownerOf(org, repo);

    // when
    const prefix = await propose(owner, org, repo, naming("VAN-9", repo.branchExample ?? ""), "chore: change the prefix");
    const example = await propose(owner, org, repo, naming(repo.commitPrefix!, "release/short-description"), "chore: change the example branch");

    try {
      // then
      expect(prefix.status).toBe(400);
      expect(prefix.error).toBe(`this repository's CI job writes its version commits with the team's prefix built in, so the prefix changes together with that job: run /handbook:init --upgrade --commit-prefix "VAN-9" from a teammate's machine, which writes the team file and the job in one request`);
      expect(example.status, example.error).toBe(200);
      expect(JSON.parse(fileAt(repo, example.request!.branch, ".teamhandbook.json")!)).toMatchObject({ commitPrefix: repo.commitPrefix, branchExample: "release/short-description" });
    } finally {
      if (example.request) await close(org, repo, example.request.number);
    }
  });

  test("given each organization, when a naming change asks for what is already recorded, or a prefix the plugin's rule refuses, then nothing opens", async () => {
    for (const org of lab.orgs.filter((o) => !o.extra)) {
      // given
      const repo = org.repos[0]!;
      const owner = await ownerOf(org, repo);

      // when
      const same = await propose(owner, org, repo, naming(repo.commitPrefix ?? "", repo.branchExample ?? ""), "chore: the same naming");
      const control = await propose(owner, org, repo, naming("PAY\u0007", ""), "chore: a control character");

      // then
      expect([same.status, same.error]).toEqual([400, "the commit prefix and the example branch are unchanged"]);
      expect([control.status, control.error]).toEqual([400, "that commit prefix cannot be recorded: it is carrying a control character"]);
    }
  });
});

// Prefixes that would run in a shell or change an expression once a CI file carries them. The
// lab's forges run no CI, so nothing here is ever executed.
const INJECTED = ['PAY" && id && echo "', "PAY $(id)", "PAY `id`", "PAY' || true || '"];

test.describe("a commit prefix that carries shell or expression syntax", () => {
  for (const org of lab.orgs.filter((o) => !o.extra)) {
    const repo = org.repos[0]!;
    test(`given ${org.name}'s ${repo.id}, when its owner asks for a prefix with a quote, $(), a backtick or a single quote, then each is refused and nothing opens`, async () => {
      // given
      const owner = await ownerOf(org, repo);

      for (const prefix of INJECTED) {
        // when
        const asked = await propose(owner, org, repo, naming(prefix, repo.branchExample ?? ""), "chore: change the prefix");
        try {
          // then
          expect([prefix, asked.status]).toEqual([prefix, 400]);
        } finally {
          if (asked.request) await close(org, repo, asked.request.number);
        }
      }
    });
  }

  test("given a repository with the version-bump CI job whose team file a teammate gave such a prefix, when its owner refreshes the scaffold, then the task refuses, or the CI file it writes takes the prefix only from the environment", async () => {
    // given
    const { org, repo } = pick("vandelay", "release-skills");
    const owner = await ownerOf(org, repo);
    // A secret-looking payload is refused by the result check by accident; this one is not.
    const payload = "VAN-7 `id` $(id)";
    await whileChanged(org, repo, { ".teamhandbook.json": JSON.stringify({ ...teamFile(repo), commitPrefix: payload }, null, 2) + "\n", "hooks/hooks.json": null }, async () => {
      // when
      // A prefix the grammar refuses is not used, so the branch falls back to the keyed example and takes an issue.
      const task = await runToReview(owner, repo, "", { template: { kind: "scaffold.refresh" }, issueUrl: "https://tracker.example.invalid/browse/VAN-321" });
      try {
        // then
        if (task.status === "needs-review") {
          for (const path of changedPaths(repo, task.request!.branch).filter((p) => p === ".gitlab-ci.yml" || p.startsWith(".github/workflows/"))) {
            expect([path, fileAt(repo, task.request!.branch, path)!.includes(payload)]).toEqual([path, false]);
          }
          expect(fileAt(repo, task.request!.branch, ".gitlab-ci.yml") ?? "").not.toContain("$(id)");
        } else {
          // Refused for the prefix itself, not for something the payload happened to look like.
          expect([task.status, task.requestNumber]).toEqual(["failed", null]);
          expect(task.error).toContain("prefix");
        }
      } finally {
        if (task.requestNumber !== null) await close(org, repo, task.requestNumber);
      }
    });
  });
});

