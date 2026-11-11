import { useState } from "react";
import type { RequestRecord } from "../api";
import { SkillEditor, SkillRemoval } from "../Editing";
import { PAGE_SIZE, Pager, pageOf } from "../Pager";
import type { RepoPanelProps } from "./types";

type Editing = { type: "skill-add" } | { type: "skill-edit"; slug: string } | { type: "skill-remove"; slug: string } | null;

/** The team's skills: what each is for, how often teammates use it, and the requests that change them. */
export function Skills({ repo, data, me, editable, usage, overlaps, onOpened, selected, onSelect }: RepoPanelProps) {
  // Skill use is what teammates' machines report; one person's own machine reads none.
  const local = me.mode === "local";
  const { inventory } = data;
  const team = inventory.team;
  const [editing, setEditing] = useState<Editing>(null);
  const [skillFilter, setSkillFilter] = useState("");
  const [skillPage, setSkillPage] = useState(1);
  const used = new Map((usage?.usage ?? []).map((u) => [u.skill, u]));
  const needle = skillFilter.trim().toLowerCase();
  const matching = needle ? inventory.skills.filter((s) => s.slug.includes(needle) || s.description.toLowerCase().includes(needle)) : inventory.skills;
  const skills = pageOf(matching, skillPage);
  const opened = (r: RequestRecord) => {
    setEditing(null);
    onOpened(r);
  };
  const formProps = { repoId: repo.id, head: inventory.head, onOpened: opened, onCancel: () => setEditing(null) };
  const stop = (fn: () => void) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    fn();
  };
  return (
    <section className="panel" aria-labelledby="skills-h">
      <h2 id="skills-h">
        Skills <span className="count">{inventory.skills.length}</span>
        {editable && inventory.skills.length ? <button type="button" className="secondary small" onClick={() => setEditing({ type: "skill-add" })}>Add a skill</button> : null}
      </h2>
      {!inventory.skills.length && !editing ? (
        <div className="empty">
          <p>{local ? "No skill here yet; the first one is in the repository once its request is merged." : editable ? "No skill is shared here yet; the first one reaches teammates once its request is merged." : `No skill is shared here yet; an owner of ${repo.team} adds the first one.`}</p>
          {editable ? <p><button type="button" onClick={() => setEditing({ type: "skill-add" })}>Add a skill</button></p> : null}
        </div>
      ) : null}
      {editing?.type === "skill-add" ? <SkillEditor {...formProps} /> : null}
      {editing?.type === "skill-edit" ? <SkillEditor key={editing.slug} {...formProps} slug={editing.slug} /> : null}
      {editing?.type === "skill-remove" ? <SkillRemoval key={editing.slug} {...formProps} slug={editing.slug} /> : null}
      {inventory.skills.length > PAGE_SIZE ? (
        <label className="filter">
          Find a skill
          <input type="search" value={skillFilter} onChange={(e) => {
            setSkillFilter(e.target.value);
            setSkillPage(1);
          }} />
        </label>
      ) : null}
      {needle && !matching.length ? <p className="muted">No skill matches “{skillFilter.trim()}”.</p> : null}
      {inventory.skills.length ? <table>
        <thead><tr><th>Skill</th><th>Description</th><th>Files</th>{local ? null : <th>Used, last {usage?.days ?? 30} days</th>}{editable ? <th><span className="visually-hidden">Changes</span></th> : null}</tr></thead>
        <tbody>
          {skills.shown.map((s) => (
            <tr key={s.slug} className={selected === `skills/${s.slug}` ? "selected" : undefined} onClick={() => onSelect(`skills/${s.slug}`)}>
              <td className="mono"><button type="button" className="link" aria-pressed={selected === `skills/${s.slug}`} onClick={() => onSelect(`skills/${s.slug}`)}>{s.slug}</button></td>
              <td>
                {s.problem ? <span className="error">{s.problem}</span> : s.description}
                {overlaps?.[s.slug]?.names.length ? <p className="muted">Answers the same requests as {overlaps[s.slug]!.names.join(", ")}{overlaps[s.slug]!.more ? ` and ${overlaps[s.slug]!.more} more` : ""}, so Claude can pick either.</p> : null}
                {s.format.length ? (
                  <details onClick={(e) => e.stopPropagation()}>
                    <summary>{s.format.length} {s.format.length === 1 ? "thing" : "things"} the plugin's skill format asks for</summary>
                    <ul>{s.format.map((f) => <li key={f}>{f}</li>)}</ul>
                  </details>
                ) : null}
              </td>
              <td>{s.files.join(", ")}</td>
              {local ? null : <td>{!team?.usageEndpoint ? <span className="muted">not reported</span> : usage?.shown === false ? <span className="muted">shown to the team's owners</span> : (used.get(s.slug)?.count ?? 0)}</td>}
              {editable ? (
                <td className="row-actions">
                  <button type="button" className="secondary small" onClick={stop(() => setEditing({ type: "skill-edit", slug: s.slug }))}>Edit</button>
                  <button type="button" className="secondary small" onClick={stop(() => setEditing({ type: "skill-remove", slug: s.slug }))}>Remove</button>
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table> : null}
      <Pager page={skills.page} total={matching.length} onPage={setSkillPage} label="Pages of skills" />
    </section>
  );
}
