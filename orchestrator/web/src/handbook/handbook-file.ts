import { call } from "../api";

/** A person's own skill or command, the only files edited from the page: in Yours or in a folder they opened. */
export type FileKind = "skill" | "command";
export interface OpenedFile { content: string | null; digest: string | null }

export const handbookFile = {
  read: (source: string, kind: FileKind, name: string) => call<OpenedFile>("GET", `/api/handbook/file?${new URLSearchParams({ source, kind, name })}`),
  /** `expectedDigest` is what the person opened, or null for a file that is new; a file changed since is refused. */
  save: (source: string, kind: FileKind, name: string, content: string, expectedDigest: string | null) => call<{ digest: string }>("PUT", "/api/handbook/file", { source, kind, name, content, expectedDigest }),
  remove: (source: string, kind: FileKind, name: string, expectedDigest: string) => call<{ deleted: true }>("DELETE", "/api/handbook/file", { source, kind, name, expectedDigest }),
};

/** Whether a source's files are the person's own, so its skills and commands are edited here; a plugin's change in its repository. */
export const ownSource = (source: string) => source === "yours" || source.startsWith("folder:");

/** The folder or file a write names: a skill is its folder, a command its file, a command's colons its folders. */
export function filePlace(source: string, kind: FileKind, name: string): string {
  const root = source === "yours" ? "~/.claude" : `${source.slice("folder:".length)}/.claude`;
  return kind === "skill" ? `${root}/skills/${name}` : `${root}/commands/${name.split(":").join("/")}.md`;
}

/** The path a save writes, said under the patch. */
export const filePath = (source: string, kind: FileKind, name: string) => (kind === "skill" ? `${filePlace(source, kind, name)}/SKILL.md` : filePlace(source, kind, name));

/** A new skill's file in the plugin's form: its name and when to use it as frontmatter, then its body. */
export function newSkillText(name: string, when: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${when.replace(/\s+/g, " ").trim()}\n---\n\n${body.trim()}\n`;
}

/**
 * A file's change as one hunk of a unified diff, every line of both shown, for the patch the
 * person reads before a save. Lines kept are the longest run the two share, so an edit reads as
 * the lines it removed and added, not the whole file twice.
 */
export function filePatch(before: string, after: string): string {
  const a = before.replace(/\n$/, "").split("\n");
  const b = after.replace(/\n$/, "").split("\n");
  const shared: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) shared[i]![j] = a[i] === b[j] ? shared[i + 1]![j + 1]! + 1 : Math.max(shared[i + 1]![j]!, shared[i]![j + 1]!);
  const lines: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      lines.push(` ${a[i++]}`);
      j++;
    } else if (i < a.length && (j === b.length || shared[i + 1]![j]! >= shared[i]![j + 1]!)) lines.push(`-${a[i++]}`);
    else lines.push(`+${b[j++]}`);
  }
  return [`@@ -1,${a.length} +1,${b.length} @@`, ...lines].join("\n");
}
