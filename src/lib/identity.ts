import { execFileSync } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { basename } from "node:path";

/**
 * Who the machine belongs to, and where that shows in text that is about to travel.
 *
 * A credential and a host identity fail differently, which is why this is not another
 * entry in `secrets.ts`. A leaked token is an incident; a leaked home directory, account
 * name or address is a reputation cost that lands on the person, not the system, and it
 * cannot be rotated away once a teammate's repository holds it. The scan is therefore
 * about the HOST, not about "personal data" in general: a colleague's name in a quoted
 * sentence is content the author chose, while the absolute path this process happens to
 * be running under is machine state nothing asked to publish.
 *
 * The class is reported, never the value. Naming it would put the trace in a log, a CLI
 * message and a report, which is the very thing the scan exists to keep out of them.
 */
export type IdentityClass = "home-path" | "os-username" | "email";

export interface HostIdentity {
  /** names belonging to the person on this machine, already filtered for the rules below */
  names: string[];
}

/**
 * An account name that names a role rather than a person: the home directory of a
 * container image, a hosted runner or a build user. Documentation is full of them - this
 * repository's own screening tests quote a BuildKit invocation reading a file out of
 * one - and flagging those costs a skill that has no leak in it, silently.
 *
 * The list is the honest weak point of the home-path rule, and it is a list of ROLES on
 * purpose: someone whose personal account happens to be named after one is missed, which
 * is the direction this trade is taken in rather than refusing every skill that documents
 * a container path.
 *
 * It reaches the account-name rule as well, and not where a reader expects: the matching in
 * `traces()` never consults it, but `usableName()` does, so a name listed here is one
 * `hostIdentity()` leaves out of the names that rule matches on. Adding a name to exempt a
 * container path therefore stops that same name being masked on a machine whose account is
 * called that, and removing one starts masking an ordinary word. The address rule keeps a
 * separate list of its own; the two are not versions of each other.
 */
const GENERIC_ACCOUNT = new Set([
  "user",
  "users",
  "username",
  "you",
  "me",
  "home",
  "root",
  "admin",
  "administrator",
  "runner",
  "ubuntu",
  "debian",
  "alpine",
  "docker",
  "container",
  "node",
  "vscode",
  "devcontainer",
  "codespace",
  "shared",
  "public",
  "dev",
  "developer",
  "test",
  "build",
  "builder",
  "ci",
  "jenkins",
  "deploy",
  "app",
  "service",
  "worker",
  "git",
  "www-data",
  "nobody",
]);

/**
 * Below this a name is a word before it is a person: a three-letter account matches
 * inside ordinary prose, and the skill it refuses is refused silently. The home-path and
 * address rules do not depend on the name at all, so what a short account name loses here
 * is only the bare mention, not the path it lives in.
 */
const MIN_NAME_CHARS = 4;

/** An absolute path into someone's home directory, in the three shapes a session shows. */
const HOME_PATH = new RegExp(
  "(?:\\/(?:Users|home)\\/|[A-Za-z]:\\\\{1,2}(?:Users|home)\\\\{1,2})([A-Za-z0-9._-]{1,40})",
  "g",
);

/**
 * An address, with an alphabetic top-level domain so that a pinned dependency
 * (`esbuild@0.23.1`) is not read as one.
 */
const EMAIL = /(?<![A-Za-z0-9._%+-])([A-Za-z0-9._%+-]+)@((?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,})/g;

/**
 * A local part that is a job rather than a person: the login every forge answers `git` to,
 * the sender that takes no mail, the queue a ticket is filed into. A skill that tells the
 * reader who to ask has to be able to say so, and none of these is anyone's inbox.
 *
 * Deliberately NOT the home-directory list. That one holds `me`, `you`, `dev`, `home`,
 * `test` and `app`, which are the commonest mailboxes a person gives themselves on their
 * own domain - borrowing it here made `me@<surname>.com` shareable, which is the exact
 * shape of a personal address and the opposite of what the exemption is for. The two rules
 * ask different questions, so they get different lists, and this one only grows with a
 * name that cannot be a person's own.
 */
export const ROLE_MAILBOX = new Set([
  "admin",
  "bot",
  "build",
  "builder",
  "ci",
  "deploy",
  "git",
  "infra",
  "jenkins",
  "no-reply",
  "noreply",
  "ops",
  "platform",
  "release",
  "root",
  "security",
  "support",
  "team",
]);

/**
 * The domains RFC 2606 set aside so that documentation can show an address without
 * owning one. Nobody's mail arrives there, and a skill that documents a configuration
 * field has to show an address somewhere - measured on a real machine, the only address
 * in an installed skill library was one of these, in a reference file. Refusing that
 * skill would have been the whole cost of the rule and none of its benefit.
 */
const RESERVED_DOMAIN = /(?:^|\.)(?:example\.(?:com|net|org)|example|test|invalid|localhost)$/i;

/**
 * The domain a forge hands out so a commit can carry an address that delivers nowhere.
 * The local part of one spells out the account it belongs to, so this is an exemption
 * taken deliberately rather than an oversight: the product already treats a forge handle
 * as public where it names a repository, and refusing the same handle in an address that
 * is not a mailbox would be the same fact judged two ways. What it buys is the line every
 * contributing guide shows - the `user.email` to set before the first commit.
 */
const ROLE_MAILBOX_DOMAIN = /(?:^|\.)users\.noreply\.github\.com$/i;

/**
 * A project owner, not a person: `<host>/<owner>/<repo>` is how a scope, a clone URL and
 * the scope sentence in a description all name the repository a lesson belongs to, and on
 * a personal repository that owner segment IS the account name. The product puts it there
 * deliberately, so a match standing in that position is left alone - otherwise every
 * lesson learned in one's own repository would be unshareable.
 */
const FORGE_OWNER_BEFORE = /[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\/$/;

const escapeRe = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function usableName(name: string): boolean {
  return name.length >= MIN_NAME_CHARS && !GENERIC_ACCOUNT.has(name.toLowerCase());
}

function gitConfig(key: string): string | null {
  try {
    return (
      execFileSync("git", ["config", "--get", key], {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        timeout: 2_000,
      }).trim() || null
    );
  } catch {
    return null;
  }
}

/**
 * The git author name is taken only when it has a space in it. A full name is
 * distinctive enough to match on sight; a single-token one is as likely to be an
 * English word, and matching that would refuse skills over a coincidence. What the
 * trade gives up is the bare handle, which the account name below usually is anyway.
 */
function gitAuthorName(): string | null {
  const name = gitConfig("user.name");
  return name && /\s/.test(name) ? name : null;
}

function readHostIdentity(): HostIdentity {
  const candidates: (string | null)[] = [];
  try {
    candidates.push(userInfo().username);
  } catch {
    // a container without a passwd entry: the other rules still apply
  }
  try {
    candidates.push(basename(homedir()));
  } catch {
    // same
  }
  candidates.push(gitAuthorName());
  const names: string[] = [];
  for (const name of candidates) {
    if (!name || !usableName(name)) continue;
    if (!names.some((seen) => seen.toLowerCase() === name.toLowerCase())) names.push(name);
  }
  return { names };
}

// Resolved once per process: every screening path below asks for it per file, and one of
// the three readings starts a git process.
let cached: HostIdentity | null = null;

export function hostIdentity(): HostIdentity {
  if (!cached) cached = readHostIdentity();
  return cached;
}

interface Trace {
  class: IdentityClass;
  index: number;
  length: number;
  replacement: string;
}

/**
 * Every trace in `text`, in the order it appears. One pass over three rules, shared by
 * the detector and the masker so the two can never disagree about what a trace is - the
 * screening path refusing something the prompt path let through would be a leak nobody
 * could see from either side.
 */
function traces(text: string, host: HostIdentity): Trace[] {
  const found: Trace[] = [];
  for (const match of text.matchAll(HOME_PATH)) {
    if (GENERIC_ACCOUNT.has((match[1] ?? "").toLowerCase())) continue;
    found.push({ class: "home-path", index: match.index, length: match[0].length, replacement: "~" });
  }
  for (const match of text.matchAll(EMAIL)) {
    const local = (match[1] ?? "").toLowerCase();
    if (ROLE_MAILBOX.has(local)) continue;
    if (RESERVED_DOMAIN.test(match[2] ?? "") || ROLE_MAILBOX_DOMAIN.test(match[2] ?? "")) continue;
    found.push({ class: "email", index: match.index, length: match[0].length, replacement: "<email>" });
  }
  if (host.names.length > 0) {
    // Longest first. A JavaScript alternation takes the leftmost branch that matches, so an
    // account name that opens the full name it sits beside ("ada" in "Ada Lovelace") would
    // win the match and leave the rest of the name standing in text on its way to a model.
    const ordered = [...host.names].sort((a, b) => b.length - a.length);
    const names = new RegExp(`\\b(?:${ordered.map(escapeRe).join("|")})\\b`, "gi");
    for (const match of text.matchAll(names)) {
      if (FORGE_OWNER_BEFORE.test(text.slice(Math.max(0, match.index - 80), match.index))) continue;
      found.push({ class: "os-username", index: match.index, length: match[0].length, replacement: "<user>" });
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

/** The class of the first host-identity trace in `text`, or null. */
export function detectIdentity(text: string, host: HostIdentity = hostIdentity()): IdentityClass | null {
  return traces(text, host)[0]?.class ?? null;
}

/**
 * The same text with every trace replaced by a neutral stand-in.
 *
 * Masking in place rather than dropping the line, which is what a secret gets: a path is
 * the shape of half the sentences in a coding session, so dropping every line carrying
 * one would take the lesson with it. `~` says what the path meant and names nobody.
 *
 * The result holds no trace of its own, so masking an already masked string changes
 * nothing and the two callers can apply it in either order.
 */
export function maskIdentity(text: string, host: HostIdentity = hostIdentity()): string {
  const found = traces(text, host);
  if (found.length === 0) return text;
  let out = "";
  let at = 0;
  for (const trace of found) {
    // Rules can overlap - an account name inside its own home path - and the first one
    // sorted wins; a second replacement inside the region already rewritten would splice
    // the string at an offset that no longer exists.
    if (trace.index < at) continue;
    out += text.slice(at, trace.index) + trace.replacement;
    at = trace.index + trace.length;
  }
  return out + text.slice(at);
}
