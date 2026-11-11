/** What a forge or tracker reads as an issue reference: `#12`, `acme/payments#12`, `PAY-142`, an address. */
const REF = String.raw`(?:issues?\s+)?(?:[\w.-]+(?:\/[\w.-]+)*#\d+|#\d+|[A-Z][A-Z0-9_]+-\d+|https?:\/\/\S+)`;

/** GitHub's and GitLab's closing words, in every form either accepts, when an issue reference follows. */
const CLOSING = new RegExp(String.raw`\b(clos(?:e[sd]?|ing)|fix(?:e[sd]|ing)?|resolv(?:e[sd]?|ing)|implement(?:s|ed|ing)?)(\s*:?\s+)(?=${REF})`, "gi");

/** A Jira smart-commit command: `#comment`, `#time`, `#done`, or any `#<transition>`. */
const SMART_COMMAND = /#(?=[A-Za-z])/g;

/**
 * Text quoted in a request with its power over the team's tracker taken out. A forge closes an
 * issue named after a closing word when the request merges, and Jira runs a `#command` written
 * after an issue key, so an agent's report - or an issue's own text it repeated - could comment
 * on, move or close an issue through the team's integration. The closing word goes in brackets,
 * which no forge reads as one, and a `#` before a word gets a space, which no smart commit reads
 * as a command; the words stay readable.
 */
export function neutralizeReferences(text: string): string {
  return text.replace(CLOSING, "[$1]$2").replace(SMART_COMMAND, "# ");
}
