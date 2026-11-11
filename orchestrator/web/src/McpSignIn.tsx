import { CopyText } from "./Confirm";
import { serviceName } from "./live-run";

/** The MCP servers of the person's own Claude Code that need a sign-in: said in one line, the services and the one way to give it folded under it. */
export function McpSignIn({ names }: { names: string[] }) {
  if (!names.length) return null;
  const services = [...new Set(names.map(serviceName))];
  return (
    <details className="muted mcp-sign-in" role="note">
      <summary>{names.length === 1 ? "1 MCP server needs" : `${names.length} MCP servers need`} sign-in</summary>
      <p>
        <span dir="auto">{services.join(", ")}</span>. To sign in, run <CopyText text="claude" />, then <span className="mono">/mcp</span>; the next task can use {names.length === 1 ? "it" : "them"}.
      </p>
    </details>
  );
}
