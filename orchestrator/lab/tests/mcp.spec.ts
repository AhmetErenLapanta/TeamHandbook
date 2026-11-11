import { expect, test } from "@playwright/test";
import { copyFile, updateMarketplace } from "../machine.js";
import type { LabRepo } from "../state.js";
import { fileAt, merge, ownerOf, propose, SHAPES, teammateOn, unique } from "./support.js";

type Servers = Record<string, unknown>;

const servers = (text: string | null): Servers => (text ? ((JSON.parse(text) as { mcpServers?: Servers }).mcpServers ?? {}) : {});
const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;

test.describe("editing and removing a team's MCP server as a request", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner adds a server, edits it and removes it, each merged, then the teammate's copy follows every step and keeps the team's other servers`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const m = teammateOn(org, repo);
      updateMarketplace(m);
      const others = servers(fileAt(repo, "HEAD", ".mcp.json"));
      const name = unique("lab-server");
      const first = { type: "http", url: "https://svc.example.invalid/mcp", headers: { Authorization: "${LAB_SERVER_AUTHORIZATION}" } };
      const second = { type: "http", url: "https://svc.example.invalid/v2/mcp", headers: { Authorization: "${LAB_SERVER_TOKEN}" } };
      const prefix = repo.commitPrefix ? `${repo.commitPrefix} ` : "";

      // when it is added and merged
      const added = await propose(owner, org, repo, { kind: "mcp.add", name, config: first }, `feat(mcp): add ${name}`);
      expect(added.status, added.error).toBe(200);
      await merge(org, repo, added.request!.number);
      updateMarketplace(m);

      // then
      expect(servers(copyFile(m, ".mcp.json"))).toEqual({ ...others, [name]: first });

      // when it is edited and merged
      const before = versionAt(repo, "HEAD");
      const edited = await propose(owner, org, repo, { kind: "mcp.edit", name, config: second }, `feat(mcp): update ${name}`);
      expect(edited.status, edited.error).toBe(200);
      expect(edited.request!.title).toBe(`${prefix}feat(mcp): update ${name}`);
      if (repo.versioning === "number") expect(versionAt(repo, edited.request!.branch)).not.toBe(before);
      await merge(org, repo, edited.request!.number);
      updateMarketplace(m);

      // then
      expect(servers(copyFile(m, ".mcp.json"))).toEqual({ ...others, [name]: second });

      // when it is removed and merged
      const removed = await propose(owner, org, repo, { kind: "mcp.remove", name }, `chore(mcp): remove ${name}`);
      expect(removed.status, removed.error).toBe(200);
      await merge(org, repo, removed.request!.number);
      updateMarketplace(m);

      // then
      expect(servers(copyFile(m, ".mcp.json"))).toEqual(others);
    });
  }

  for (const { shape, org, repo } of SHAPES.filter((s) => Object.keys(servers(fileAt(s.repo, "HEAD", ".mcp.json"))).length)) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner edits a server to a literal credential, to what it already is, or edits or removes one the team does not have, then each is refused and the literal value is never repeated`, async () => {
      // given: a token assembled here, so no file of the repository holds one
      const owner = await ownerOf(org, repo);
      const [name, config] = Object.entries(servers(fileAt(repo, "HEAD", ".mcp.json")))[0]! as [string, Record<string, unknown>];
      const literal = ["lab", "literal", Date.now().toString(36), "Qw8Er7Ty6Ui5"].join("_");
      const field = "headers" in config ? "headers" : "env";
      const key = Object.keys((config[field] ?? {}) as Record<string, unknown>)[0] ?? "TOKEN";
      const missing = unique("no-such-server");

      // when
      const leaked = await propose(owner, org, repo, { kind: "mcp.edit", name, config: { ...config, [field]: { [key]: literal } } }, `feat(mcp): update ${name}`);
      const same = await propose(owner, org, repo, { kind: "mcp.edit", name, config }, `feat(mcp): update ${name}`);
      const strayEdit = await propose(owner, org, repo, { kind: "mcp.edit", name: missing, config }, `feat(mcp): update ${missing}`);
      const strayRemove = await propose(owner, org, repo, { kind: "mcp.remove", name: missing }, `chore(mcp): remove ${missing}`);

      // then
      expect(leaked.status).toBe(400);
      expect(leaked.error).toContain(`${field}.${key} holds a literal value`);
      expect(JSON.stringify(leaked)).not.toContain(literal);
      expect([same.status, same.error]).toEqual([400, `${name} is unchanged`]);
      expect([strayEdit.status, strayEdit.error]).toEqual([400, `.mcp.json declares no server ${missing} to edit`]);
      expect([strayRemove.status, strayRemove.error]).toEqual([400, `.mcp.json declares no server ${missing} to remove`]);
    });
  }
});
