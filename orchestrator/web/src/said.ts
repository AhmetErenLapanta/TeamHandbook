/**
 * A message as a sentence of its own: capital first, full stop last. The server writes its reasons
 * in lower case so one can sit inside another ("reading x failed: <reason>"); the page says each
 * whole. Only a plain word is capitalised: a reason that opens with a name, a path or a tool's own
 * output ("ada-laptop is offline", "~/code holds", "fatal: …") keeps it as it is written.
 */
export function sentence(text: string): string {
  const said = text.trim();
  if (!said) return said;
  const opened = /^[a-z]+ /.test(said) ? `${said.charAt(0).toUpperCase()}${said.slice(1)}` : said;
  return /[.!?]$/.test(opened) ? opened : `${opened}.`;
}

const MERGE_AT = ": git merge ";

/**
 * A refused merge whose reason ends with the command to run where the branch is checked out, cut
 * into the words and the command so the command can be copied as it is. The full stop the page
 * adds is not part of it: git takes no branch name that ends in one.
 */
export function mergeCommand(reason: string): { said: string; command: string } | null {
  const at = reason.lastIndexOf(MERGE_AT);
  if (at < 0) return null;
  const command = reason.slice(at + 2).replace(/\.$/, "").trim();
  return command.length > MERGE_AT.length - 2 ? { said: reason.slice(0, at), command } : null;
}
