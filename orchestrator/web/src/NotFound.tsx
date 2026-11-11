import { pathIn } from "./router";

/** An address the orchestrator has no page for, said as such, with the way back into the organization. */
export function NotFoundPage({ org, path }: { org: string; path: string }) {
  return (
    <div className="page">
      <header className="page-head"><h1>Page not found</h1></header>
      <section className="panel" aria-label="Page not found">
        <p>This orchestrator has no page at <code className="link">{path}</code>. The link is mistyped, or it is from a page that has moved.</p>
        <p><a className="button secondary" href={pathIn(org, "tasks")}>Back to {org}</a></p>
      </section>
    </div>
  );
}
