import { useEffect, useRef, useState } from "react";
import { call } from "./api";
import { CopyText } from "./Confirm";
import { signInServers } from "../../shared/mcp-sign-in";

type Start = { authorizeUrl: string } | { signedIn: true };
type Waiting = { state: "waiting" | "signed-in" | "failed"; why?: string };
type Step = { at: "starting" } | { at: "waiting" } | { at: "failed"; why: string };

/** How often a sign-in that has not come back is asked about, and for how long: Claude Code's own listener waits about as long. */
export const SIGN_IN_POLL_MS = 2_000;
const SIGN_IN_WAIT_MS = 180_000;

const path = (name: string) => `/api/me/claude-mcp/${encodeURIComponent(name)}/sign-in`;

/**
 * The MCP servers of the person's own Claude Code that need a sign-in: said in one line, the way to
 * give it by hand folded under it, and, on one person's own orchestrator, a button for each that
 * starts the sign-in in their Claude Code. Nothing starts but by that press; the page opens the
 * sign-in in another tab and asks until it has come back.
 */
export function McpSignIn({ names, onePerson = false }: { names: string[]; onePerson?: boolean }) {
  const [steps, setSteps] = useState<Record<string, Step>>({});
  const [signed, setSigned] = useState<readonly string[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  const all = signInServers(names);
  const left = all.filter((s) => !signed.includes(s.name));
  if (!left.length && !signed.length) return null;
  const set = (name: string, step: Step | null) => setSteps((all) => {
    const next = { ...all };
    if (step) next[name] = step;
    else delete next[name];
    return next;
  });
  const wait = (name: string, until: number) => {
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      call<Waiting>("GET", path(name)).then(
        (r) => {
          if (r.state === "signed-in") {
            set(name, null);
            setSigned((s) => [...s, name]);
          } else if (r.state === "failed") set(name, { at: "failed", why: r.why ?? "The sign-in did not finish." });
          else if (Date.now() < until) wait(name, until);
          else set(name, { at: "failed", why: "The sign-in did not come back; try again, or sign in with claude and /mcp." });
        },
        (e: Error) => set(name, { at: "failed", why: e.message }),
      );
    }, SIGN_IN_POLL_MS);
    timers.current.add(timer);
  };
  const start = (name: string) => {
    set(name, { at: "starting" });
    call<Start>("POST", path(name)).then(
      (r) => {
        if ("signedIn" in r) {
          set(name, null);
          setSigned((s) => [...s, name]);
          return;
        }
        window.open(r.authorizeUrl, "_blank", "noopener");
        set(name, { at: "waiting" });
        wait(name, Date.now() + SIGN_IN_WAIT_MS);
      },
      (e: Error) => set(name, { at: "failed", why: e.message }),
    );
  };
  return (
    <div className="muted mcp-sign-in" role="note">
      {left.length ? (
        <details>
          <summary>{left.length === 1 ? "1 MCP server needs" : `${left.length} MCP servers need`} sign-in</summary>
          {onePerson ? (
            <div className="mcp-sign-in-buttons">
              {left.map(({ name, label }) => {
                const step = steps[name];
                return (
                  <span key={name} className="mcp-sign-in-row">
                    <button type="button" className="secondary small" disabled={step?.at === "starting" || step?.at === "waiting"} onClick={() => start(name)}>{`Sign in to ${label}`}</button>
                    {step?.at === "waiting" ? <span role="status"> Waiting for the sign-in in the other tab…</span> : null}
                    {step?.at === "failed" ? <span className="error" role="alert"> {step.why}</span> : null}
                  </span>
                );
              })}
            </div>
          ) : <p dir="auto">{left.map((s) => s.label).join(", ")}</p>}
          <p className="small">Or run <CopyText text="claude" />, then <span className="mono">/mcp</span>, in your terminal.</p>
        </details>
      ) : null}
      {signed.length ? <p role="status">Signed in to {all.filter((s) => signed.includes(s.name)).map((s) => s.label).join(", ")}; the next task can use {signed.length === 1 ? "it" : "them"}.</p> : null}
    </div>
  );
}
