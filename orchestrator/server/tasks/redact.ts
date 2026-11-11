import { detectSecret } from "../plugin.js";

const KEY_BEGIN = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/;
const KEY_END = /-----END [A-Z0-9 ]*PRIVATE KEY-----/;
const MAX_LINE = 2000;
/** `user:token@` in an address, the shape a git or forge error repeats back from a repository URL. */
const URL_CREDENTIAL = /(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi;

/** A credential shorter than this is too likely to occur by chance in ordinary text to mask by value. */
export const MIN_LITERAL = 8;

/**
 * The redaction every task log line passes before it is stored. Two rules, because neither
 * covers the other: the plugin's secret patterns catch a token the agent printed from a file,
 * and the literal values of the credentials the orchestrator itself handed the agent are masked
 * whatever their format, since a provider key with an unfamiliar shape matches no pattern.
 * A private key block is withheld from its BEGIN line to its END line: the lines between
 * are base64 that no single-line pattern recognises. The user part of an address is masked
 * on every line, whatever it holds: an error from git or a forge repeats a repository URL,
 * and a token in it has the shape of a user name.
 */
export class Redactor {
  private inKey = false;
  private readonly literals: string[];

  constructor(literals: Iterable<string> = []) {
    this.literals = [...literals].filter((v) => v.length >= MIN_LITERAL).sort((a, b) => b.length - a.length);
  }

  /** Adds values learned once the task started, such as the vault's task secrets, to the ones masked from here on. */
  add(literals: Iterable<string>): void {
    this.literals.push(...[...literals].filter((v) => v.length >= MIN_LITERAL));
    this.literals.sort((a, b) => b.length - a.length);
  }

  /** True when a value the orchestrator handed the agent occurs in the text. */
  carriesCredential(text: string): boolean {
    return this.literals.some((v) => text.includes(v));
  }

  line(raw: string): string {
    let text = raw;
    for (const value of this.literals) text = text.split(value).join("[redacted:credential]");
    text = text.replace(URL_CREDENTIAL, "$1***@");
    if (this.inKey) {
      if (KEY_END.test(text)) this.inKey = false;
      return "[redacted:private-key]";
    }
    if (KEY_BEGIN.test(text)) {
      this.inKey = !KEY_END.test(text);
      return "[redacted:private-key]";
    }
    const secret = detectSecret(text);
    if (secret) return `[redacted:${secret}]`;
    // Cut only after every rule above has run on the whole line: a token cut first would
    // leave a part that neither its value nor its pattern matches.
    return text.length > MAX_LINE ? `${text.slice(0, MAX_LINE)}…` : text;
  }
}
