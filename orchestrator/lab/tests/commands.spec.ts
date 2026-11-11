import { expect, test } from "@playwright/test";
import { copyFile, updateMarketplace } from "../machine.js";
import type { LabOrg, LabRepo } from "../state.js";
import { as, fileAt, merge, ownerOf, propose, SHAPES, teammateOn, unique } from "./support.js";

const commandText = (line: string) => `---\ndescription: Check what the lab asks of a slash command\n---\n${line}\n`;
const versionAt = (repo: LabRepo, ref: string) => (JSON.parse(fileAt(repo, ref, ".claude-plugin/plugin.json") ?? "{}") as { version?: string }).version;

async function commands(org: LabOrg, repo: LabRepo): Promise<{ name: string; file: string; description: string }[]> {
  return (await (await as(org, "member")).ok<{ inventory: { commands: { name: string; file: string; description: string }[] } }>("GET", `/api/repos/${repo.id}/inventory`)).inventory.commands;
}

test.describe("a team's slash commands changed as requests", () => {
  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner adds a command in a folder, edits it and removes it, each merged, then the inventory and the teammate's copy follow every step`, async () => {
      // given
      const owner = await ownerOf(org, repo);
      const m = teammateOn(org, repo);
      updateMarketplace(m);
      const leaf = unique("lab-command");
      const name = `git:${leaf}`;
      const file = `commands/git/${leaf}.md`;
      const prefix = repo.commitPrefix ? `${repo.commitPrefix} ` : "";

      // when it is added and merged
      const added = await propose(owner, org, repo, { kind: "command.add", name, content: commandText("Run the first version.") }, `feat(command): add /${name}`);
      expect(added.status, added.error).toBe(200);
      expect(added.request!.title).toBe(`${prefix}feat(command): add /${name}`);
      await merge(org, repo, added.request!.number);
      updateMarketplace(m);

      // then
      expect(await commands(org, repo)).toEqual(expect.arrayContaining([{ name, file, description: "Check what the lab asks of a slash command" }]));
      expect(copyFile(m, file)).toBe(commandText("Run the first version."));

      // when it is edited and merged
      const before = versionAt(repo, "HEAD");
      const edited = await propose(owner, org, repo, { kind: "command.edit", name, content: commandText("Run the second version.") }, `feat(command): update /${name}`);
      expect(edited.status, edited.error).toBe(200);
      if (repo.versioning === "number") expect(versionAt(repo, edited.request!.branch)).not.toBe(before);
      await merge(org, repo, edited.request!.number);
      updateMarketplace(m);

      // then
      expect(copyFile(m, file)).toBe(commandText("Run the second version."));
      expect((await (await as(org, "member")).ok<{ content: string }>("GET", `/api/repos/${repo.id}/commands/${name}`)).content).toBe(commandText("Run the second version."));

      // when it is removed and merged
      const removed = await propose(owner, org, repo, { kind: "command.delete", name }, `chore(command): remove /${name}`);
      expect(removed.status, removed.error).toBe(200);
      await merge(org, repo, removed.request!.number);
      updateMarketplace(m);

      // then
      expect((await commands(org, repo)).map((c) => c.name)).not.toContain(name);
      expect(copyFile(m, file)).toBeNull();
    });
  }

  for (const { shape, org, repo } of SHAPES) {
    test(`given ${org.name}'s ${repo.id}, ${shape}, when its owner sends a command carrying a token or one machine's path, an existing name, an unchanged text, a missing command or a name that is no command's, then each is refused and the token is never repeated`, async () => {
      // given: values assembled here, so no file of the repository holds one
      const owner = await ownerOf(org, repo);
      const token = ["ghp", "Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0Lz9Xc8Vb"].join("_");
      const home = ["", "Users", "lab-person", "notes.txt"].join("/");
      const name = unique("lab-refused");
      const added = await propose(owner, org, repo, { kind: "command.add", name, content: commandText("Run it.") }, `feat(command): add /${name}`);
      expect(added.status, added.error).toBe(200);
      await merge(org, repo, added.request!.number);
      const missing = unique("no-such-command");

      // when
      const secret = await propose(owner, org, repo, { kind: "command.edit", name, content: commandText(`Call the API with ${token}.`) }, `feat(command): update /${name}`);
      const machine = await propose(owner, org, repo, { kind: "command.edit", name, content: commandText(`Read ${home} first.`) }, `feat(command): update /${name}`);
      const again = await propose(owner, org, repo, { kind: "command.add", name, content: commandText("Run it.") }, `feat(command): add /${name}`);
      const same = await propose(owner, org, repo, { kind: "command.edit", name, content: commandText("Run it.") }, `feat(command): update /${name}`);
      const strayEdit = await propose(owner, org, repo, { kind: "command.edit", name: missing, content: commandText("Run it.") }, `feat(command): update /${missing}`);
      const strayDelete = await propose(owner, org, repo, { kind: "command.delete", name: missing }, `chore(command): remove /${missing}`);
      const badName = await propose(owner, org, repo, { kind: "command.add", name: "Not A Command", content: commandText("Run it.") }, "feat(command): add");
      // A name Windows keeps for a device breaks a teammate's checkout there.
      const device = await propose(owner, org, repo, { kind: "command.add", name: "tools:con", content: commandText("Run it.") }, "feat(command): add /tools:con");

      // then
      expect(secret.status).toBe(400);
      expect(secret.error).toMatch(new RegExp(`^/${name} is not shareable as written: commands/${name}\\.md line \\d+ looks like it contains a secret`));
      expect(JSON.stringify(secret)).not.toContain(token);
      expect(machine.status).toBe(400);
      expect(machine.error).toContain("carries a trace of one machine");
      expect([again.status, again.error]).toEqual([400, `/${name} already exists; edit it instead`]);
      expect([same.status, same.error]).toEqual([400, `/${name} is unchanged`]);
      expect([strayEdit.status, strayEdit.error]).toEqual([400, `there is no command /${missing} to edit`]);
      expect([strayDelete.status, strayDelete.error]).toEqual([400, `there is no command /${missing} to remove`]);
      expect(device.status).toBe(400);
      expect(device.error).toContain("not a device name Windows keeps");
      expect([badName.status, badName.error]).toEqual([400, "a command name is lower-case letters, digits and dashes, with a colon between a folder and the name, at most four deep, and not a device name Windows keeps, such as con or nul"]);
    });
  }
});
