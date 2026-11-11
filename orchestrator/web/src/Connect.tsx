import type { ReactNode } from "react";

/**
 * One service as Integrations offers it: what it gives in one sentence, its state, the one main
 * action of that state, which finishes with an approval in the browser, and every detailed way of
 * connecting folded under "Other ways to connect". GitLab, GitHub, Gitea, Jira and the catalogue's
 * services are each drawn with it, so a person connects any of them the same way.
 */
export function Connect({ id, name, about, connected, action, status, other, error, level = 2 }: {
  id: string;
  name: string;
  /** Unconnected, what connecting gives; connected, what it reads now and where to go. */
  about: ReactNode;
  connected: boolean;
  action: ReactNode;
  /** Where a sign-in under way stands, read out as it changes: the code to enter, what it waits for. */
  status?: ReactNode;
  other?: ReactNode;
  error?: string | null;
  /** The card's heading level: 2 on its own, 3 inside a group of cards under its own heading. */
  level?: 2 | 3;
}) {
  const Heading = level === 3 ? "h3" : "h2";
  return (
    // Inside a card the card is the box; the section's own hairline and spacing would stack on it.
    <section id={`card-${id}`} className={level === 3 ? "connect" : "section connect"} aria-labelledby={`${id}-h`}>
      <div className="connect-head">
        <Heading id={`${id}-h`}>{name}</Heading>
        {connected ? <span className="state ok">Connected</span> : null}
      </div>
      <p>{about}</p>
      {status ? <div className="connect-status" role="status">{status}</div> : null}
      <div className="actions">{action}</div>
      {other ? (
        <details className="other-ways">
          <summary>Other ways to connect</summary>
          {other}
        </details>
      ) : null}
      {error ? <p className="error" role="alert">{error}</p> : null}
    </section>
  );
}
