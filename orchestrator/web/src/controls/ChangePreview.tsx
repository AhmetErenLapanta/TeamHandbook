import { useEffect, useState } from "react";
import { api, people } from "../api";
import type { ChangeInput } from "../api";
import { here } from "../router";
import { policiesApi } from "./api";
import { changeImpact } from "./impact";
import type { ChangeImpact } from "./impact";
import { list } from "./policy";

/**
 * What a change touches, shown on the review step before its request opens: who gets it, how
 * much the skill is used, the skills it overlaps, and the policies already holding it. A part
 * the orchestrator cannot read is left out rather than holding up the request.
 */
export function ChangePreview({ repoId, change }: { repoId: string; change: ChangeInput }) {
  const [impact, setImpact] = useState<ChangeImpact | null | undefined>(undefined);
  const key = JSON.stringify(change);
  useEffect(() => {
    let live = true;
    const skill = change.kind.startsWith("skill.");
    Promise.all([
      people.teams().catch(() => []),
      skill ? api.usage(repoId).catch(() => ({ days: 30, usage: [] })) : Promise.resolve({ days: 30, usage: [] }),
      skill ? api.overlaps(repoId).then((o) => o.overlaps).catch(() => ({})) : Promise.resolve({}),
      policiesApi.list().then((l) => l.policies).catch(() => []),
    ]).then(([teams, usage, overlaps, policies]) => {
      if (live) setImpact(changeImpact(repoId, change, { teams, usage: usage.usage, usageDays: usage.days, overlaps, policies }));
    });
    return () => {
      live = false;
    };
  }, [repoId, key]);

  if (impact === null) return null;
  if (impact === undefined) return <p className="muted change-preview" aria-busy="true">Checking what this change touches…</p>;
  const who = impact.team ? `teammates on ${impact.team}` : "teammates using this repository";
  return (
    <section className="change-preview" aria-label="What this change touches">
      <p className="field-label">What this change touches</p>
      <ul className="plain">
        <li>{impact.removing ? `Once merged, ${who} lose ${impact.subject}.` : `Once merged, ${who} get this version of ${impact.subject}.`}</li>
        {impact.usage ? (
          <li>
            {impact.usage.count
              ? `Used ${impact.usage.count.toLocaleString("en-US")} ${impact.usage.count === 1 ? "time" : "times"} in the last ${impact.usage.days} days${impact.usage.lastHour ? `, last on ${impact.usage.lastHour.slice(0, 10)}` : ""}.`
              : `No reported use in the last ${impact.usage.days} days.`}
          </li>
        ) : null}
        {impact.overlap && !impact.removing ? (
          <li>Answers the same requests as {list(impact.overlap.names)}{impact.overlap.more ? ` and ${impact.overlap.more} more` : ""}; a session picks one of them.</li>
        ) : null}
        {impact.policies.map((p) => (
          <li key={p.id}>
            The policy <a href={here("team", "policies", p.id)}>{p.name}</a> {impact.removing ? "blocks it today; that rule stays in the team file." : "blocks it; teammates keep being stopped from using it after the merge."}
          </li>
        ))}
      </ul>
    </section>
  );
}
