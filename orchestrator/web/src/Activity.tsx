import { AiRequestsPage } from "./AiRequests";
import type { Principal, RepoRecord } from "./api";
import { AuditEntry, AuditPage, LogsPage } from "./Logs";
import { ACTIVITY_PAGES, activityPageInMode, activityPagesFor } from "./navigation";
import { here, placeOf } from "./router";
import { NotFoundPage } from "./NotFound";
import { SubNav } from "./Shell";
import { PageHead } from "./design/PageHead";
import { LeaderboardPage, UsagePage } from "./Usage";
import { WHATS_NEW } from "./whats-new";

/** Every change worth telling, newest first, reached from the account menu. */
function News() {
  return (
    <ul className="plain news-list">
      {WHATS_NEW.map((item) => (
        <li key={item.id}>
          <h2>{item.title}</h2>
          <p className="muted">{item.body}</p>
          {item.link ? <p><a href={item.link.page ? here(item.link.section, item.link.page) : here(item.link.section)}>{item.link.label}</a></p> : null}
        </li>
      ))}
    </ul>
  );
}

export function ActivityView({ me, repos, page, entry }: { me: Principal; repos: RepoRecord[] | null; page: string | undefined; entry?: string }) {
  const current = ACTIVITY_PAGES.find((p) => p.id === page && activityPageInMode(me, p.id));
  if (!current) return <NotFoundPage org={placeOf(window.location.pathname).org ?? ""} path={window.location.pathname} />;
  const to = (id: string) => here("activity", id);
  const nav = <SubNav label="Activity" current={to(current.id)} links={activityPagesFor(me).map((p) => ({ to: to(p.id), label: p.label }))} />;
  return (
    <div className="page">
      <PageHead title={current.label} />
      {nav}
      {current.id === "news" ? <News /> : null}
      {current.id === "usage" ? <UsagePage me={me} repos={repos} /> : null}
      {current.id === "leaderboard" ? <LeaderboardPage me={me} /> : null}
      {current.id === "ai" ? <AiRequestsPage /> : null}
      {current.id === "logs" ? <LogsPage repos={repos} me={me.email} /> : null}
      {current.id === "audit" ? (entry ? <AuditEntry me={me} id={entry} /> : <AuditPage me={me} repos={repos} />) : null}
    </div>
  );
}
