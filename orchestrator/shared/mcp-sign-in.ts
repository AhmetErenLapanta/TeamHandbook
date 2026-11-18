/** A service an MCP server is known to reach, by a word in its name. */
const SERVICES: Record<string, string> = { jira: "Jira", confluence: "Confluence", github: "GitHub", gitlab: "GitLab", sentry: "Sentry", linear: "Linear", notion: "Notion", slack: "Slack" };

export interface SignInServer {
  /** The name Claude Code knows the server by: what the sign-in is started with. */
  name: string;
  /** The name a person reads: the service, and the plugin it comes from when a plugin brought it. */
  label: string;
}

const words = (text: string) => text.replace(/([a-z0-9])([A-Z])/g, "$1 $2").split(/[\s_\-.]+/).filter(Boolean);
const capitalized = (word: string) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();

/** Claude Code names a plugin's server `plugin:<plugin>:<server>` and a claude.ai connector `claude.ai <Name>`. */
function parts(name: string): { server: string; plugin: string | null; connector: boolean } {
  const plugin = /^plugin:([^:]+):(.+)$/.exec(name);
  if (plugin) return { server: plugin[2]!, plugin: plugin[1]!, connector: false };
  const connector = /^claude[._ ]ai[._ ](.+)$/i.exec(name);
  if (connector) return { server: connector[1]!, plugin: null, connector: true };
  return { server: name, plugin: null, connector: false };
}

function serviceOf(server: string): string {
  const all = words(server);
  const known = all.find((w) => SERVICES[w.toLowerCase()]);
  return known ? SERVICES[known.toLowerCase()]! : all.map(capitalized).join(" ") || server;
}

/**
 * The servers asking for a sign-in as a person reads them, each service once. A plugin's server is
 * `Atlassian (from <plugin>)`; one reached both as a claude.ai connector and as a server of the
 * person's own is one row, started under the name of the one that is not the connector.
 */
export function signInServers(names: readonly string[]): SignInServer[] {
  const found = new Map<string, SignInServer & { connector: boolean }>();
  for (const name of names) {
    const { server, plugin, connector } = parts(name);
    const label = plugin ? `${serviceOf(server)} (from ${plugin})` : serviceOf(server);
    const seen = found.get(label.toLowerCase());
    if (!seen) found.set(label.toLowerCase(), { name, label, connector });
    else if (seen.connector && !connector) found.set(label.toLowerCase(), { name, label, connector });
  }
  return [...found.values()].map(({ name, label }) => ({ name, label }));
}
