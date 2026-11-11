import { expect, test } from "@playwright/test";
import { copyFile, doctor, machineOf, updateMarketplace } from "../machine.js";
import { ORGS } from "../orgs.js";
import { userOf, ownerKey } from "../state.js";
import type { LabOrg, LabRepo } from "../state.js";
import { builtIn, close, commitOf, fileAt, headOf, lab, merge, onForge, ownerOf, propose, unique } from "./support.js";

const skillText = (slug: string, line: string) => `---\nname: ${slug}\ndescription: Use when the lab checks that an edit reaches a teammate.\n---\n\n${line}\n`;
const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;
const firstSkill = (org: LabOrg, repo: LabRepo) => ORGS.find((o) => o.name === org.name)!.teams.find((t) => t.id === repo.id)!.skills[0]!.slug;
const forgeName = (repo: LabRepo) => (repo.forge === "local" ? "the orchestrator's local forge" : repo.forge === "gitlab" ? "the stand-in GitLab" : "the stand-in GitHub");

test.describe("a change made on the orchestrator reaches a teammate", () => {
  for (const org of builtIn) {
    const dev = org.developers[0]!;
    const repo = org.repos.find((r) => r.id === dev.repo)!;

    test(`given ${org.name}'s ${repo.id}, versioned by ${repo.versioning}, and a teammate whose copy is current, when its owner's skill edit is merged on ${forgeName(repo)}, then the teammate's doctor finds the copy behind until the marketplace updates, and then the copy holds the edit`, async () => {
      // given
      const m = machineOf(lab, dev);
      updateMarketplace(m);
      expect(doctor(m).teamCopy).toMatch(/^✔ team plugin copy/);
      const owner = await ownerOf(org, repo);
      const person = userOf(org, ownerKey(repo.team));
      const slug = firstSkill(org, repo);
      const text = skillText(slug, `Edited in the lab: ${unique("edit")}`);
      const before = versionAt(repo, "HEAD");

      // when
      const opened = await propose(owner, org, repo, { kind: "skill.edit", slug, content: text }, `update ${slug}`);

      // then the request carries the team's prefix and the person who asked
      expect(opened.status, opened.error).toBe(200);
      const request = opened.request!;
      expect(request.title).toBe(repo.commitPrefix ? `${repo.commitPrefix} update ${slug}` : `update ${slug}`);
      expect(commitOf(repo, request.branch, "%an <%ae>|%s")).toBe(`${person.name} <${person.email}>|${request.title}`);
      if (repo.forge !== "local") {
        expect(await onForge(repo, request.number)).toMatchObject({ state: "opened", source: request.branch, labels: repo.labels, reviewers: repo.reviewers });
      }
      expect(fileAt(repo, "HEAD", `skills/${slug}/SKILL.md`)).not.toBe(text);

      // when a person merges it
      await merge(org, repo, request.number);

      // then the orchestrator shows the edit, and the teammate's doctor says the copy is behind
      expect((await owner.ok<{ content: string }>("GET", `/api/repos/${repo.id}/skills/${slug}`)).content).toBe(text);
      if (repo.versioning === "number") {
        const after = versionAt(repo, "HEAD")!;
        // Raised past the default branch's version and every version an unmerged branch claims, as the plugin raises it.
        const [a, b] = [after, before!].map((v) => v.split(".").map(Number)) as [number[], number[]];
        expect(a[0] === b[0] && a[1] === b[1] && a[2]! > b[2]!).toBe(true);
        expect(doctor(m).teamCopy).toBe(`⚠ team plugin copy: this machine's marketplace copy is at v${before} but the team repo is at v${after}, so merged skills have not reached this machine - run \`claude plugin update ${repo.id}@${repo.id}\` (or \`/plugin\` > Marketplaces > Update marketplace), then start a new session or run \`/reload-plugins\`; if the next merge leaves it behind again after a restart, turn auto-update on for this marketplace from \`/plugin\``);
      } else {
        expect(doctor(m).teamCopy).toMatch(/^⚠ team plugin copy: this machine's marketplace copy is at commit [0-9a-f]{12} but the team repo is at [0-9a-f]{12}, so what was merged since has not reached this machine/);
      }

      // when the marketplace updates
      updateMarketplace(m);

      // then
      expect(doctor(m).teamCopy).toMatch(/^✔ team plugin copy/);
      expect(copyFile(m, `skills/${slug}/SKILL.md`)).toBe(text);
    });
  }

  for (const org of builtIn) {
    const dev = org.developers[0]!;
    const repo = org.repos.find((r) => r.id === dev.repo)!;
    test(`given ${org.name}'s ${repo.id}, when its owner removes a skill and the request is merged on ${forgeName(repo)}, then the teammate's copy no longer holds it after the update`, async () => {
      // given a skill the team has, merged and on the teammate's copy
      const owner = await ownerOf(org, repo);
      const m = machineOf(lab, dev);
      const slug = unique("short-lived");
      const added = await propose(owner, org, repo, { kind: "skill.add", slug, content: skillText(slug, "Here for one merge.") }, `add ${slug}`);
      expect(added.status, added.error).toBe(200);
      await merge(org, repo, added.request!.number);
      updateMarketplace(m);
      expect(copyFile(m, `skills/${slug}/SKILL.md`)).not.toBeNull();

      // when
      const removed = await propose(owner, org, repo, { kind: "skill.delete", slug }, `remove ${slug}`);
      expect(removed.status, removed.error).toBe(200);
      await merge(org, repo, removed.request!.number);
      updateMarketplace(m);

      // then
      expect(fileAt(repo, "HEAD", `skills/${slug}/SKILL.md`)).toBeNull();
      expect(copyFile(m, `skills/${slug}/SKILL.md`)).toBeNull();
      expect(doctor(m).teamCopy).toMatch(/^✔ team plugin copy/);
    });
  }

  for (const org of builtIn) {
    const repo = org.repos.find((r) => r.branchExample)!;
    // A team that polices branch names refuses the orchestrator's own handbook/orchestrator-... shape.
    test(`given ${org.name}'s ${repo.id}, whose team names branches like ${repo.branchExample}, when its owner's change opens a request, then the branch follows the team's rule`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = unique("branch-rule");

      // when
      const opened = await propose(owner, org, repo, { kind: "skill.add", slug, content: skillText(slug, "Checks the branch rule.") }, `add ${slug}`);
      try {
        // then
        expect(opened.status, opened.error).toBe(200);
        const example = repo.branchExample!;
        expect(opened.request!.branch.startsWith("handbook/")).toBe(false);
        if (example.includes("/")) expect(opened.request!.branch.startsWith(example.slice(0, example.lastIndexOf("/") + 1))).toBe(true);
        // A commit prefix that is a ticket key names the branch first, as the plugin's share does.
        if (/^[A-Z][A-Z0-9]+-\d+$/.test(repo.commitPrefix ?? "")) expect(opened.request!.branch.startsWith(`${repo.commitPrefix}-`)).toBe(true);
      } finally {
        if (opened.request) await close(org, repo, opened.request.number);
      }
    });
  }

  for (const org of builtIn) {
    const repo = org.repos.find((r) => r.versioning === "number")!;
    // Two open requests that claim one number leave the second merge raising nothing teammates fetch.
    test(`given ${org.name}'s ${repo.id}, versioned by number, when two edits are open at once, then each request raises the plugin to a different version`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const first = unique("claim-one");
      const second = unique("claim-two");

      // when
      const one = await propose(owner, org, repo, { kind: "skill.add", slug: first, content: skillText(first, "One.") }, `add ${first}`);
      const two = await propose(owner, org, repo, { kind: "skill.add", slug: second, content: skillText(second, "Two.") }, `add ${second}`);
      try {
        // then
        expect([one.status, two.status]).toEqual([200, 200]);
        expect(versionAt(repo, one.request!.branch)).not.toBe(versionAt(repo, two.request!.branch));
      } finally {
        for (const r of [one, two]) if (r.request) await close(org, repo, r.request.number);
      }
    });
  }
});

test.describe("what a forge does with a request's people", () => {
  for (const org of builtIn.filter((o) => o.repos.some((r) => r.forge !== "local"))) {
    const repo = org.repos.find((r) => r.reviewers.some((name) => !ORGS.find((o) => o.name === org.name)!.forgeUsers.includes(name))) ?? null;
    if (!repo) continue;
    test(`given ${org.name}'s ${repo.id}, whose reviewers name a login ${forgeName(repo)} does not know, when a change opens, then the request opens and the unknown login is named beside it`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const slug = unique("reviewers");

      // when
      const opened = await propose(owner, org, repo, { kind: "skill.add", slug, content: skillText(slug, "Checks the reviewers.") }, `add ${slug}`);
      try {
        // then
        expect(opened.status, opened.error).toBe(200);
        expect(opened.request!.notes?.join("\n")).toContain("nobody-here");
        expect((await onForge(repo, opened.request!.number)).state).toBe("opened");
      } finally {
        if (opened.request) await close(org, repo, opened.request.number);
      }
    });
  }
});

test.describe("an MCP server with a credential", () => {
  for (const org of builtIn) {
    const repo = org.repos[0]!;
    test(`given ${org.name}'s ${repo.id}, when its owner adds a server whose header holds a literal token, then it is refused naming the key and never the value, and with a reference it opens on ${forgeName(repo)}`, async () => {
      // given: a token assembled here, so no file of the repository holds one
      const literal = ["lab", "literal", "token", Date.now().toString(36), "Zx9Qw8Er7Ty6"].join("_");
      const owner = await ownerOf(org, repo);
      const name = unique("vault");

      // when
      const refused = await propose(owner, org, repo, { kind: "mcp.add", name, config: { type: "http", url: "https://vault.example.invalid/mcp", headers: { Authorization: literal } } }, `add ${name}`);
      const bearer = await propose(owner, org, repo, { kind: "mcp.add", name, config: { type: "http", url: "https://vault.example.invalid/mcp", headers: { Authorization: "Bearer ${VAULT_TOKEN}" } } }, `add ${name}`);
      const referenced = await propose(owner, org, repo, { kind: "mcp.add", name, config: { type: "http", url: "https://vault.example.invalid/mcp", headers: { Authorization: "${VAULT_AUTHORIZATION}" } } }, `add ${name}`);

      try {
        // then
        expect(refused.status).toBe(400);
        expect(refused.error).toContain("headers.Authorization holds a literal value");
        expect(JSON.stringify(refused)).not.toContain(literal);
        // The plugin's share rule takes a whole value as a reference, not one inside a longer string.
        expect(bearer.status).toBe(400);
        expect(bearer.error).toContain("headers.Authorization holds a literal value");
        expect(referenced.status, referenced.error).toBe(200);
        expect(JSON.parse(fileAt(repo, referenced.request!.branch, ".mcp.json")!).mcpServers[name].headers).toEqual({ Authorization: "${VAULT_AUTHORIZATION}" });
      } finally {
        if (referenced.request) await close(org, repo, referenced.request.number);
      }
    });
  }
});

test.describe("two requests at the same moment", () => {
  for (const org of builtIn) {
    const repo = org.repos.find((r) => r.versioning === "number")!;
    // Each version is read from the mirror; two requests prepared before either is opened read the same one.
    test(`given ${org.name}'s ${repo.id}, versioned by number, when two edits are sent at the same moment, then each request raises the plugin to a different version`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const head = await headOf(org, repo);
      const slugs = [unique("race-one"), unique("race-two")];
      const branches = await Promise.all(
        slugs.map(async (slug) => {
          const change = { kind: "skill.add", slug, content: skillText(slug, "Sent at the same moment.") };
          const { branch } = await owner.ok<{ branch: string }>("POST", `/api/repos/${repo.id}/changes/proposal`, { change });
          return { change, branch: branch.replace("<TICKET>", `LAB-${100 + Math.floor(Math.random() * 900)}`), slug };
        }),
      );

      // when
      const replies = await Promise.all(branches.map((b) => owner.call<{ request?: { number: number; branch: string }; error?: string }>("POST", `/api/repos/${repo.id}/changes`, { baseSha: head, change: b.change, message: `add ${b.slug}`, branch: b.branch })));
      try {
        // then
        expect(replies.map((r) => r.status)).toEqual([200, 200]);
        const [one, two] = replies.map((r) => versionAt(repo, r.json.request!.branch));
        expect(one).not.toBe(two);
      } finally {
        for (const r of replies) if (r.json.request) await close(org, repo, r.json.request.number);
      }
    });
  }
});

