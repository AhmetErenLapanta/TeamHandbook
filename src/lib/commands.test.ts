import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCommand, commandDescription, commandRefusalMessage, readLocalCommands } from "./commands.js";

let userHome: string;
let project: string;

function writeCommand(root: string, name: string, body: string): string {
  const dir = join(root, ".claude", "commands");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.md`);
  writeFileSync(file, body);
  return file;
}

beforeEach(() => {
  userHome = mkdtempSync(join(tmpdir(), "handbook-user-"));
  project = mkdtempSync(join(tmpdir(), "handbook-project-"));
});

afterEach(() => {
  for (const dir of [userHome, project]) rmSync(dir, { recursive: true, force: true });
});

describe("readLocalCommands", () => {
  it("given commands in both scopes, when they are read, then each arrives with the scope it loads in", () => {
    writeCommand(userHome, "explain", "Explain something.\n");
    writeCommand(project, "deploy", "Deploy something.\n");

    const commands = readLocalCommands(userHome, project);

    expect(commands.map((c) => [c.name, c.scope])).toEqual([
      ["explain", "personal"],
      ["deploy", "project"],
    ]);
  });

  it("given the same name in both scopes, when they are read, then the project one wins as Claude Code resolves it", () => {
    writeCommand(userHome, "explain", "The personal one.\n");
    writeCommand(project, "explain", "The project one.\n");

    const commands = readLocalCommands(userHome, project);

    expect(commands).toHaveLength(1);
    expect(commands[0]!.scope).toBe("project");
    expect(auditCommand(commands[0]!.file).content).toBe("The project one.\n");
  });

  it("given files that are not commands beside the commands, when they are read, then only the markdown is a command", () => {
    writeCommand(userHome, "explain", "Explain something.\n");
    // the real directory this was measured against has a .DS_Store in it
    writeFileSync(join(userHome, ".claude", "commands", ".DS_Store"), "\u0000junk");
    mkdirSync(join(userHome, ".claude", "commands", "git"), { recursive: true });
    writeFileSync(join(userHome, ".claude", "commands", "git", "sync.md"), "Namespaced.\n");

    expect(readLocalCommands(userHome, project).map((c) => c.name)).toEqual(["explain"]);
  });

  it("given no commands directory at all, when it is read, then it is an empty setup rather than a crash", () => {
    expect(readLocalCommands(userHome, project)).toEqual([]);
  });
});

describe("commandDescription", () => {
  it("given frontmatter with a description, when it is read, then the description is what the list shows", () => {
    const text = "---\nallowed-tools: Bash\ndescription: Fix every failing test.\n---\n\nBody.\n";

    expect(commandDescription(text)).toBe("Fix every failing test.");
  });

  it("given no frontmatter at all, when it is read, then the first real line stands in for it", () => {
    // a command with no frontmatter is one Claude Code runs happily, so it is described
    // rather than refused
    expect(commandDescription("# Title\n\nDeep-dive explanation of code.\n")).toBe("Deep-dive explanation of code.");
  });

  it("given an empty command, when it is read, then it describes itself as nothing rather than throwing", () => {
    expect(commandDescription("")).toBe("");
  });
});

describe("auditCommand", () => {
  it("given an ordinary command, when it is audited, then the text it cleared is the text it hands back", () => {
    const file = writeCommand(userHome, "explain", "---\ndescription: Explain it.\n---\n\nSteps.\n");

    const audit = auditCommand(file);

    expect(audit.shareable).toBe(true);
    expect(audit.content).toBe("---\ndescription: Explain it.\n---\n\nSteps.\n");
    expect(audit.description).toBe("Explain it.");
  });

  it("given a command carrying a credential, when it is audited, then it is refused and the pattern is named", () => {
    const file = writeCommand(userHome, "deploy", "Run: curl -H 'Authorization: Bearer ghp_aaaabbbbccccddddeeeeffff'\n");

    const audit = auditCommand(file);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("secret");
    expect(audit.secret?.file).toBe("deploy.md");
    // refusing, not redacting: a command with the token blanked out arrives and misfires,
    // so the message names the fix the author has to make instead of offering to make one
    expect(commandRefusalMessage("deploy", audit)).toContain("take the credential out");
    expect(commandRefusalMessage("deploy", audit)).toContain("github-token");
  });

  it("given a name that is not a safe path component, when it is audited, then it cannot travel under it", () => {
    const file = writeCommand(userHome, "Deploy Prod", "Nothing secret here.\n");

    const audit = auditCommand(file);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("unsafe-name");
  });

  it("given a command that cannot be read, when it is audited, then unscreened means refused", () => {
    const dir = join(userHome, ".claude", "commands");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "broken.md");
    symlinkSync(join(dir, "nothing-here.md"), file);

    const audit = auditCommand(file);

    expect(audit.shareable).toBe(false);
    expect(audit.reason).toBe("unreadable");
  });
});
