import { describe, expect, it } from "vitest";
import { filePatch, filePath, filePlace, newSkillText, ownSource } from "./handbook-file";

describe("a person's own file as the editor says it", () => {
  it("given a skill whose middle step changed, when its patch is made, then it keeps the shared lines and shows the one removed and the one added", () => {
    // when
    const patch = filePatch("---\nname: triage\n---\nRead the ticket.\nGuess.\nReply.\n", "---\nname: triage\n---\nRead the ticket.\nAsk first.\nReply.\n");

    // then
    expect(patch).toBe("@@ -1,6 +1,6 @@\n ---\n name: triage\n ---\n Read the ticket.\n-Guess.\n+Ask first.\n Reply.");
  });

  it("given a skill and a command in Yours and in a folder, when where each is written is said, then a skill names its folder and SKILL.md, and a command's colons are its folders", () => {
    // then
    expect(filePlace("yours", "skill", "release-notes")).toBe("~/.claude/skills/release-notes");
    expect(filePath("yours", "skill", "release-notes")).toBe("~/.claude/skills/release-notes/SKILL.md");
    expect(filePath("folder:/work/payments-api", "command", "release:notes")).toBe("/work/payments-api/.claude/commands/release/notes.md");
    expect([ownSource("yours"), ownSource("folder:/work/payments-api"), ownSource("plugin:payments-skills@payments-market")]).toEqual([true, true, false]);
  });

  it("given a new skill's three fields, when its text is made, then it is in the plugin's form with its name and when to use it on one line", () => {
    // then
    expect(newSkillText("release-notes", "When a release\n is cut", "  Write the notes.  ")).toBe("---\nname: release-notes\ndescription: When a release is cut\n---\n\nWrite the notes.\n");
  });
});
