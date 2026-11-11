/**
 * What the orchestrator counts of its calls to forges, for the metrics a scraper reads: calls by
 * forge, host, operation and status class, and the quota each forge reported left. Every label is
 * from a fixed set or the API's host name: never a path, query, project, branch or commit, which
 * would put a team's repository names and commit ids into whatever stores the metrics.
 */

/** What a call does, named from its path by a fixed table; anything the table does not name is "other". */
const OPERATIONS: [RegExp, string][] = [
  [/\/(merge_requests|pulls)(\/|\?|$)/, "request"],
  [/\/(approvals|reviews)(\/|\?|$)/, "review"],
  [/\/(statuses|status|check-runs)(\/|\?|$)/, "checks"],
  [/\/repository\/commits|\/git\/commits/, "commit"],
  [/\/repository\/files|\/contents\//, "file"],
  [/\/repository\/(branches|tags)|\/(branches|tags)(\/|\?|$)|\/git\/ref/, "ref"],
  [/\/git\/trees/, "tree"],
  [/\/hooks(\/|\?|$)/, "hook"],
  [/\/users?(\/|\?|$)|\/namespaces\//, "account"],
  [/\/installation|\/app\//, "installation"],
  [/^\/(projects|orgs\/[^/]+\/repos|repos\/[^/]+\/[^/]+)(\?|$)/, "repository"],
];

export function operationOf(method: string, path: string): string {
  const verb = /^(GET|POST|PUT|PATCH|DELETE)$/.test(method) ? method.toLowerCase() : "other";
  return `${verb} ${OPERATIONS.find(([pattern]) => pattern.test(path))?.[1] ?? "other"}`;
}

/** A status as a class: 2xx, 3xx, 4xx and 5xx, 429 apart, and "unreachable" for no answer. */
export function statusClass(status: number): string {
  if (status === 0) return "unreachable";
  if (status === 429) return "429";
  return `${Math.floor(status / 100)}xx`;
}

export class ForgeMeter {
  readonly calls = new Map<string, number>();
  readonly quota = new Map<string, { remaining: number; limit: number | null }>();

  called(forge: string, host: string, operation: string, status: string): void {
    const key = [forge, host, operation, status].join("\0");
    this.calls.set(key, (this.calls.get(key) ?? 0) + 1);
  }

  reported(forge: string, host: string, remaining: number, limit: number | null): void {
    this.quota.set(`${forge}\0${host}`, { remaining, limit });
  }
}

export const forgeMeter = new ForgeMeter();
