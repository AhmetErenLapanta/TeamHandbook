import { useEffect, useState } from "react";
import { here } from "../router";
import { policiesApi } from "./api";
import type { PolicyProposal, PolicySaved, RequestConfirmation } from "./api";
import { list } from "./policy";
import { removalApi, usageLine } from "./removal";
import type { RemovableKind, RemovalImpact } from "./removal";
import { ConfirmRequests, OpenedRequests } from "./Save";
import { Hint } from "../Hint";

type Disabling = { at: "offer" } | { at: "confirm"; plan: Extract<PolicyProposal, { applies: "request" }> } | { at: "opened"; saved: Extract<PolicySaved, { saved: "request" }> };

/**
 * What removing a skill or an MCP server takes away, shown on its removal form, with the
 * choice to block it with the team policy the orchestrator proposes and keep its files. Nothing
 * shows when the orchestrator does not answer: the removal itself goes on as before.
 */
export function RemovalImpactPanel({ repoId, kind, name }: { repoId: string; kind: RemovableKind; name: string }) {
  const [impact, setImpact] = useState<RemovalImpact | null | undefined>(undefined);
  const [disabling, setDisabling] = useState<Disabling>({ at: "offer" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    removalApi.impact(repoId, kind, name).then((i) => live && setImpact(i), () => live && setImpact(null));
    return () => {
      live = false;
    };
  }, [repoId, kind, name]);

  if (impact === null) return null;
  if (impact === undefined) return <p className="muted removal-impact" aria-busy="true">Checking what removing {name} takes away…</p>;
  const draft = impact.disable;
  const teams = draft && draft.audience.kind === "teams" ? list(draft.audience.ids) : null;
  const offer = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    await policiesApi.proposal(null, draft).then(
      (plan) => (plan.applies === "request" ? setDisabling({ at: "confirm", plan }) : setError("This policy would not open a request; disable it from Controls.")),
      (e: Error) => setError(e.message),
    );
    setBusy(false);
  };
  const confirm = async (c: RequestConfirmation) => {
    if (!draft) return;
    const saved = await policiesApi.save(null, draft, c);
    if (saved.saved === "request") setDisabling({ at: "opened", saved });
  };

  return (
    <section className="removal-impact" aria-label="What this removal takes away">
      <ul className="plain">
        <li>{teams ? `Teammates on ${teams}` : "Teammates using this repository"} lose {name} once the request is merged.</li>
        {impact.usage ? <li>{usageLine(impact.usage)}</li> : null}
      </ul>
      {impact.blockedBy.length ? (
        <p className="muted">
          Already blocked by {impact.blockedBy.map((p, i) => <span key={p.id}>{i ? ", " : ""}<a href={here("team", "policies", p.id)}>{p.name}</a></span>)}; removing it also deletes its files.
        </p>
      ) : null}
      {draft && disabling.at === "offer" ? (
        <div className="disable-instead">
          <p className="muted">Keeps its files and blocks it for the team. <Hint label="disabling instead">It is written to every repository of {teams ?? "the team"} and reviewed there; deleting the policy later turns {name} back on.</Hint></p>
          {error ? <p className="error" role="alert">{error}</p> : null}
          <button type="button" className="secondary small" onClick={offer} disabled={busy}>{busy ? "Preparing…" : "Disable instead"}</button>
        </div>
      ) : null}
      {disabling.at === "confirm" ? <ConfirmRequests plan={disabling.plan} action={`Disable ${name}`} onConfirm={confirm} onCancel={() => setDisabling({ at: "offer" })} /> : null}
      {disabling.at === "opened" ? <OpenedRequests saved={disabling.saved} repoName={(id) => id} back={here("team")} /> : null}
    </section>
  );
}
