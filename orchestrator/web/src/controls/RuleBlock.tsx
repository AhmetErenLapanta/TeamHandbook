import { useId, useState } from "react";
import { ChipField } from "./ChipField";
import type { Choice } from "./ChipField";
import { MAX_MONTHLY_USD, REASON_MAX, RULE_BLOCKS, resourceLabel, resourceOf, TOOLS } from "./policy";
import type { DeveloperKind, DeveloperRule, Rule } from "./policy";
import { DEFAULT_MODE, MODE_LABEL, MODE_MEANS, modeRank, PERMISSION_MODES } from "../../../shared/permission-mode";
import type { PermissionMode } from "../../../shared/permission-mode";
import { Select } from "../Select";
import { Hint } from "../Hint";

const PREFIX_OF: Record<DeveloperKind, string> = { "skill-access": "skill:", "mcp-access": "mcp:", "tool-access": "tool:" };

function ToolPatterns({ rule, onChange }: { rule: DeveloperRule; onChange: (rule: Rule) => void }) {
  const id = useId();
  const [tool, setTool] = useState<string>(TOOLS[0]);
  const [pattern, setPattern] = useState("");
  const add = () => {
    const resource = resourceOf("tool-access", `${tool}:${pattern.trim() || "*"}`);
    if (!rule.resources.includes(resource)) onChange({ ...rule, resources: [...rule.resources, resource] });
    setPattern("");
  };
  return (
    <div className="chip-field">
      <span className="field-label" id={`${id}-l`}>Tools and what they are held to</span>
      {rule.resources.length ? (
        <ul className="chips" aria-labelledby={`${id}-l`}>
          {rule.resources.map((r) => (
            <li key={r} className="chip">
              <span>{resourceLabel(r)}</span>
              <button type="button" className="chip-remove" aria-label={`Remove ${resourceLabel(r)}`} onClick={() => onChange({ ...rule, resources: rule.resources.filter((x) => x !== r) })}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="chip-add">
        <Select label="Tool" labelHidden value={tool} onChange={setTool} options={TOOLS.map((t) => ({ value: t, label: t }))} />
        <label className="visually-hidden" htmlFor={`${id}-pattern`}>Pattern</label>
        <input
          id={`${id}-pattern`}
          value={pattern}
          placeholder={tool === "Bash" ? "rm *" : tool === "WebFetch" ? "https://example.com/*" : "*.env"}
          onChange={(e) => setPattern(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="secondary small" onClick={add}>Add</button>
      </div>
      <p className="muted small-print">An empty pattern blocks the whole tool. <Hint label="tool patterns">Edit covers every tool that changes a file.</Hint></p>
    </div>
  );
}

function DeveloperFields({ rule, onChange }: { rule: DeveloperRule; onChange: (rule: Rule) => void }) {
  const id = useId();
  const prefix = PREFIX_OF[rule.kind];
  return (
    <>
      {rule.kind === "tool-access" ? (
        <ToolPatterns rule={rule} onChange={onChange} />
      ) : (
        <ChipField
          label={rule.kind === "skill-access" ? "Skills to block" : "MCP servers to block"}
          placeholder={rule.kind === "skill-access" ? "deploy-checklist" : "server or server/tool"}
          values={rule.resources.map((r) => r.slice(prefix.length))}
          onChange={(values) => onChange({ ...rule, resources: values.map((v) => resourceOf(rule.kind, v)) })}
        />
      )}
      <div className="field">
        <label htmlFor={`${id}-reason`}>Reason teammates see</label>
        <input id={`${id}-reason`} value={rule.reason} maxLength={REASON_MAX} placeholder="Say why, in a sentence" onChange={(e) => onChange({ ...rule, reason: e.target.value })} />
      </div>
    </>
  );
}

export function RuleBlock({ rule, index, onChange, onRemove, repos }: { rule: Rule; index: number; onChange: (rule: Rule) => void; onRemove: () => void; repos: Choice[] }) {
  const id = useId();
  const label = RULE_BLOCKS.find((b) => b.kind === rule.kind)?.label ?? rule.kind;
  return (
    <section className="panel rule-block" aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`}>
        {label} <span className="count">rule {index + 1}</span>
        <button type="button" className="secondary small" aria-label={`Remove the ${label} rule`} onClick={onRemove}>Remove</button>
      </h2>
      {rule.kind === "task-budget" ? (
        <>
          <div className="field">
            <label htmlFor={`${id}-usd`}>Monthly limit in US dollars</label>
            <input
              id={`${id}-usd`}
              type="number"
              inputMode="decimal"
              min={0.01}
              max={MAX_MONTHLY_USD}
              step="any"
              value={rule.monthlyUsd ?? ""}
              onChange={(e) => onChange({ ...rule, monthlyUsd: e.target.value === "" ? null : Number(e.target.value) })}
            />
          </div>
          <fieldset className="plain-fieldset choice-row">
            <legend>The limit is</legend>
            <label className="check"><input type="radio" name={`${id}-per`} checked={rule.per === "audience"} onChange={() => onChange({ ...rule, per: "audience" })} /> shared by everyone it applies to</label>
            <label className="check"><input type="radio" name={`${id}-per`} checked={rule.per === "member"} onChange={() => onChange({ ...rule, per: "member" })} /> for each member</label>
          </fieldset>
          <p className="muted small-print">Counts what agents report for tasks this calendar month (UTC). <Hint label="task budgets">A task that reports no cost is not counted.</Hint></p>
        </>
      ) : rule.kind === "repo-access" ? (
        <>
          <fieldset className="plain-fieldset choice-row">
            <legend>Tasks on these repositories are</legend>
            <label className="check"><input type="radio" name={`${id}-effect`} checked={rule.effect === "allow"} onChange={() => onChange({ ...rule, effect: "allow" })} /> allowed</label>
            <label className="check"><input type="radio" name={`${id}-effect`} checked={rule.effect === "deny"} onChange={() => onChange({ ...rule, effect: "deny" })} /> blocked</label>
          </fieldset>
          <ChipField label="Repositories" placeholder="repository id, or * for every one" values={rule.repos} choices={repos} onChange={(values) => onChange({ ...rule, repos: values })} />
          <p className="muted small-print">The last rule that matches decides; a repository no rule names stays open.</p>
        </>
      ) : rule.kind === "task-mode" ? (
        <>
          <Select label="Agents work at most in" value={rule.ceiling} onChange={(v) => onChange({ ...rule, ceiling: v as PermissionMode })} options={PERMISSION_MODES.map((m) => ({ value: m, label: `${MODE_LABEL[m]}: ${MODE_MEANS[m]}` }))} />
          <ChipField label="Repositories" placeholder="repository id, or * for every one" values={rule.repos} choices={repos} onChange={(values) => onChange({ ...rule, repos: values })} />
          <p className="muted small-print">
            {modeRank(rule.ceiling) < modeRank(DEFAULT_MODE)
              ? `A task that names no mode starts in the most its agent offers up to ${MODE_LABEL[rule.ceiling]}, and asks its starter before anything more; one asking for more is refused, and an agent that runs in no mode this low takes no task here.`
              : "A task asking for more is refused, both when it starts and again before its agent runs; a task can always ask for less. The lowest ceiling that covers a task holds."}
          </p>
        </>
      ) : rule.kind === "own-setup" ? (
        <>
          <label className="check"><input type="checkbox" checked={rule.allowed} onChange={(e) => onChange({ ...rule, allowed: e.target.checked })} /> Tasks use the starter's own Claude Code setup</label>
          <ChipField label="Repositories" placeholder="repository id, or * for every one" values={rule.repos} choices={repos} onChange={(values) => onChange({ ...rule, repos: values })} />
          <p className="muted small-print">{rule.allowed ? "A task on a person's machine runs with their memory, CLAUDE.md, skills, plugins, MCP servers and hooks, and the team's skills on top." : "A task on a person's machine runs with their sign-in and the team's skills only."}</p>
        </>
      ) : (
        <DeveloperFields rule={rule} onChange={onChange} />
      )}
    </section>
  );
}
