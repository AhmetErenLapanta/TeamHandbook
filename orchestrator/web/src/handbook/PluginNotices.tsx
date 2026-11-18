import { useState } from "react";
import type { ReactNode } from "react";
import type { HandbookSource } from "./handbook-read";

const counted = (n: number, one: string, many: string) => (n ? `${n} ${n === 1 ? one : many}` : null);

/** "payments-skills 1.5.0 runs 2 hooks and 1 MCP server", or for several "3 plugins run hooks or servers: a, b, c": one line, never one each. */
export function noticeSaid(plugins: HandbookSource[]): string {
  if (plugins.length === 1) {
    const [only] = plugins as [HandbookSource];
    const n = only.notice!;
    const runs = [counted(n.hooks, "hook", "hooks"), counted(n.mcpServers, "MCP server", "MCP servers")].filter(Boolean).join(" and ");
    return `${only.name}${only.version ? ` ${only.version}` : ""} runs ${runs}.`;
  }
  return `${plugins.length} plugins run hooks or servers: ${plugins.map((p) => p.name).join(", ")}.`;
}

/**
 * What the plugins the person has not been told about run, said once in one line with "Look" and a written "Got it".
 * Nothing waits on it: Got it puts the line away and says once that nothing changed.
 */
export function PluginNotices({ sources, look, putAway }: { sources: HandbookSource[]; look: ReactNode; putAway: (plugin: HandbookSource) => Promise<unknown> }) {
  const [gone, setGone] = useState<string[]>([]);
  const [said, setSaid] = useState(false);
  const news = sources.filter((s) => s.kind === "plugin" && s.notice && (s.notice.hooks || s.notice.mcpServers) && !gone.includes(s.id));
  const gotIt = () => {
    setGone((now) => [...now, ...news.map((s) => s.id)]);
    setSaid(true);
    for (const s of news) void putAway(s).catch(() => undefined);
  };
  if (!news.length) return said ? <p className="muted small" aria-live="polite">Put away; nothing changed.</p> : null;
  return (
    <p className="muted small handbook-news">
      {noticeSaid(news)} {look}{" "}
      <button type="button" className="secondary small" onClick={gotIt}>Got it</button>
    </p>
  );
}
