import { Component, useRef } from "react";
import type { ReactNode } from "react";
import { CopyButton } from "./Confirm";

/** What a fault in a page leaves to copy into a report: the message and where it was thrown. */
export function errorReport(error: Error, path: string): string {
  return [`${error.name}: ${error.message}`, `at ${path}`, ...(error.stack ? [error.stack] : [])].join("\n");
}

function Fault({ error, path, home }: { error: Error; path: string; home: string }) {
  const report = useRef<HTMLPreElement>(null);
  const text = errorReport(error, path);
  return (
    <section className="panel problem" role="alert" aria-labelledby="fault-h">
      <h2 id="fault-h">Something went wrong on this page</h2>
      <p>The rest of the orchestrator still works. Go back, or copy the error for whoever runs this orchestrator.</p>
      <pre ref={report} className="pre mono fault">{text}</pre>
      <div className="actions">
        <a className="button secondary" href={home}>Back to Tasks</a>
        <CopyButton text={text} target={report} label="Copy error" />
      </div>
    </section>
  );
}

/**
 * Holds a fault thrown while one section draws to that section, so the tabs, the organization
 * and the account menu stay usable. Moving to another page clears the fault; the section itself
 * stays mounted, so a page keeps what it already read while its address changes.
 */
export class SectionBoundary extends Component<{ path: string; home: string; children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override componentDidCatch(error: Error) {
    console.error(error);
  }

  override componentDidUpdate(previous: { path: string }) {
    if (this.state.error && previous.path !== this.props.path) this.setState({ error: null });
  }

  override render() {
    return this.state.error ? <Fault error={this.state.error} path={this.props.path} home={this.props.home} /> : this.props.children;
  }
}
