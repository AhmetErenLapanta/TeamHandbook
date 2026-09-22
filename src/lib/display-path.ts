import { homedir } from "node:os";
import { sep } from "node:path";

/**
 * A path as it should be PRINTED, not as it should be read: the user's home collapsed
 * to `~`. Presentation only - callers keep the absolute path for every file operation.
 *
 * The product's output is made to be shown to someone else: a candidate gets screenshotted,
 * pasted into a support thread, forwarded to a teammate. An absolute path carries the OS
 * account name, so it is the one line that has to be deleted by hand first.
 *
 * A path outside the home (a custom TEAMHANDBOOK_HOME under /opt, say) is printed as it is:
 * there is no shorter form that keeps the information, and truncating one would cost the
 * reader the location the line exists to give.
 */
export function displayPath(path: string, userHome: string = homedir()): string {
  // The type is not a guarantee at every call site: a candidate.json is a disk field that
  // readCandidateMeta passes through unchecked, so a hand-edited "cwd": 12345 arrives here
  // typed as a string. Shortening is a courtesy, and a courtesy must never be the reason a
  // delivery that used to succeed throws instead. String() reproduces what the template
  // printed before this helper existed.
  if (typeof path !== "string") return String(path);
  // An empty home is a prefix of everything: without this, every absolute path would be
  // printed with a "~" glued to its front.
  if (!userHome) return path;
  if (path === userHome) return "~";
  // The separator is part of the test: a plain startsWith turns the sibling
  // /home/dev-backup into "~-backup" when the home is /home/dev.
  if (path.startsWith(userHome + sep)) return `~${path.slice(userHome.length)}`;
  return path;
}
