import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { api, ApiError } from "./api";

export const FORGE = {
  gitlab: { name: "GitLab", noun: "merge request", title: "Merge request", mark: "!" },
  github: { name: "GitHub", noun: "pull request", title: "Pull request", mark: "#" },
} as const;

/**
 * Where a request on one person's own orchestrator reaches, in its parts for the page to place: the
 * sentence (their checkout only when they keep it, the forge only through the request they open
 * there), the action that opens it there, and why it could not. Nothing leaves the machine on its own.
 */
export function useForgeReach(repoId: string, number: number): { line: ReactNode | null; action: ReactNode | null; refusal: ReactNode | null } {
  const [state, setState] = useState<{ forge: "gitlab" | "github" | null; url: string | null; number: number | null } | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<{ message: string; createUrl: string | null } | null>(null);
  useEffect(() => {
    api.onForge(repoId, number).then(setState, () => setState(null));
  }, [repoId, number]);
  if (state === undefined) return { line: null, action: null, refusal: null };
  if (!state?.forge) return { line: <p className="muted">Your checkout changes only when you keep this.</p>, action: null, refusal: null };
  const forge = FORGE[state.forge];
  if (state.url) {
    const n = state.number;
    return {
      line: <p>{n !== null ? <>{forge.title} <a href={state.url} target="_blank" rel="noopener noreferrer">{forge.mark}{n}</a></> : <a href={state.url} target="_blank" rel="noopener noreferrer">A {forge.noun}</a>} is open on {forge.name}.</p>,
      action: null,
      refusal: null,
    };
  }
  const open = () => {
    setBusy(true);
    setRefused(null);
    api.openOnForge(repoId, number).then(({ url, number: opened }) => setState({ forge: state.forge, url, number: opened }), (e: Error) => {
      const createUrl = e instanceof ApiError && typeof e.body.createUrl === "string" ? e.body.createUrl : null;
      setRefused({ message: e.message, createUrl });
    }).finally(() => setBusy(false));
  };
  return {
    line: <p className="muted">Your checkout changes only when you keep this, and nothing reaches {forge.name} until you open a {forge.noun} there.</p>,
    action: <button type="button" className="secondary" disabled={busy} onClick={open}>{busy ? `Opening a ${forge.noun}…` : `Open a ${forge.noun}`}</button>,
    refusal: refused ? (
      <p className="error" role="alert">
        {refused.message}
        {refused.createUrl ? <> <a href={refused.createUrl} target="_blank" rel="noopener noreferrer">Open the filled-in page on {forge.name}</a></> : null}
      </p>
    ) : null,
  };
}

/** The forge reach of a request answered elsewhere on the page, as the task's head does for one repository. */
export function ForgeReach({ repoId, number }: { repoId: string; number: number }) {
  const { line, action, refusal } = useForgeReach(repoId, number);
  return (
    <>
      {line}
      {action ? <div className="actions">{action}</div> : null}
      {refusal}
    </>
  );
}
