/**
 * Services a person connects in one step, each by its vendor's own remote MCP server and that
 * server's sign-in: the orchestrator adds it as the person's own server and, once they approve it
 * in the browser, allows only the tools that read. ORCHESTRATOR_CATALOG_<ID>_URL names another
 * address for an entry, such as a stand-in on this machine.
 */
export interface CatalogEntry {
  id: string;
  name: string;
  /** What connecting it gives, in one sentence. */
  about: string;
  url: string;
}

// Each one registers the orchestrator with its sign-in itself (dynamic client registration), which a
// one-step sign-in needs; Slack's server takes only apps registered with Slack beforehand, so it is
// not offered here. Linear's address serves its reading tools alone.
export const CATALOG: readonly CatalogEntry[] = [
  { id: "linear", name: "Linear", about: "Read your Linear issues and projects in tasks you start.", url: "https://mcp.linear.app/mcp/readonly" },
  { id: "notion", name: "Notion", about: "Read your Notion pages and databases in tasks you start.", url: "https://mcp.notion.com/mcp" },
  { id: "sentry", name: "Sentry", about: "Read your Sentry issues and their events in tasks you start.", url: "https://mcp.sentry.dev/mcp" },
];

export const catalogUrl = (entry: CatalogEntry): string => process.env[`ORCHESTRATOR_CATALOG_${entry.id.toUpperCase()}_URL`] ?? entry.url;
