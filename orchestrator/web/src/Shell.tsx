import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { api, auth, identityApi, manages, ONBOARDING_CHANGED, tasksApi } from "./api";
import { AttentionWatcher, NOTIFY_KEY } from "./AttentionWatcher";
import { CommandPalette } from "./design/CommandPalette";
import { folderAsk, MOST_A_GROUP } from "./design/palette";
import type { Jump } from "./design/palette";
import { homeRelative, pastedPath, projectsRead } from "./projects-read";
import { Shortcuts } from "./design/Shortcuts";
import { activityPageInMode, activityPagesFor, settingsSectionsFor } from "./navigation";
import type { Org, PendingInvitation, Principal, RepoRecord } from "./api";
import { applyTheme, THEME_KEY, usePref } from "./prefs";
import type { Theme } from "./prefs";
import { navigate, pathIn } from "./router";
import type { Section } from "./router";

// The four sections of the job: what needs doing, the tasks agents do, the team around them, and the
// services they reach. Settings sit in the account menu and the repositories on Tasks' own rail.
const TABS: { section: Section; label: string }[] = [
  { section: "work", label: "Work" },
  { section: "tasks", label: "Tasks" },
  { section: "team", label: "Team" },
  { section: "integrations", label: "Integrations" },
];


/** A button that opens a panel below it; Escape and a click elsewhere close it. */
export function Disclosure({ label, summary, className, children }: { label: string; summary: ReactNode; className?: string; children: (close: () => void) => ReactNode }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, [open]);
  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.stopPropagation();
      close();
    }
  };
  return (
    <div className={`disclosure ${className ?? ""}`} ref={root} onKeyDown={onKey}>
      <button ref={button} type="button" className="ghost" aria-expanded={open} aria-controls={id} aria-label={label} onClick={() => setOpen(!open)}>{summary}</button>
      <div id={id} className="popover" hidden={!open}>{open ? children(() => setOpen(false)) : null}</div>
    </div>
  );
}

/** Which organization the pages show; one organization needs no picker, so it shows none. */
/**
 * The invitations waiting for this person's own address, read when the picker opens: accepting
 * one opens the organization it joins, and declining one takes it off the list for good.
 */
function Invitations({ onJoined }: { onJoined: () => void }) {
  const [waiting, setWaiting] = useState<PendingInvitation[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const read = () => identityApi.orgs().then((r) => setWaiting(r.invitations), (e: Error) => setError(e.message));
  useEffect(() => {
    void read();
  }, []);
  const act = (id: string, accept: boolean) => {
    setError(null);
    identityApi.me().then((view) => (accept ? identityApi.acceptInvitation(id, view.csrf).then((joined) => {
      onJoined();
      navigate(joined.next);
    }) : identityApi.declineInvitation(id, view.csrf).then(read))).catch((e: Error) => setError(e.message));
  };
  if (error) return <p className="error small" role="alert">{error}</p>;
  if (!waiting?.length) return null;
  return (
    <>
      <p className="popover-title">Invitations</p>
      <ul className="plain invitations">
        {waiting.map((inv) => (
          <li key={inv.id}>
            <span>{inv.orgName} <span className="muted">· {inv.role}, from {inv.invitedBy}</span></span>
            <span className="row-actions">
              <button type="button" className="small" onClick={() => act(inv.id, true)}>Accept</button>
              <button type="button" className="secondary small" aria-label={`Decline the invitation to ${inv.orgName}`} onClick={() => act(inv.id, false)}>Decline</button>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The organizations this person belongs to, by the name each is shown by. A switch keeps the
 * section and drops the rest of the address, since a task or a repository of one organization is
 * not another's. In the cloud it also starts a new organization, so it shows even with one.
 */
function OrgPicker({ me, orgs, org, section }: { me: Principal; orgs: Org[]; org: string; section: string | null }) {
  const [other, setOther] = useState("");
  const otherId = useId();
  const cloud = me.mode === "cloud";
  if (me.mode === "local" || (orgs.length < 2 && !cloud)) return null;
  const shown = (o: Org) => o.orgName ?? o.tenant;
  const here = orgs.find((o) => o.tenant === org);
  const current = here ? shown(here) : org;
  return (
    <Disclosure label={`Organization: ${current}`} summary={<><span className="org-mark" aria-hidden="true">{current.slice(0, 1).toUpperCase()}</span><span className="org-name">{current}</span></>} className="org-picker">
      {(close) => (
        <>
          <p className="popover-title">Organizations</p>
          <ul className="plain">
            {orgs.map((o) => (
              <li key={o.tenant}>
                <a href={pathIn(o.tenant, section ?? "tasks")} aria-current={o.tenant === org ? "true" : undefined} onClick={close}>
                  {shown(o)} <span className="muted">· {o.role}</span>
                </a>
              </li>
            ))}
          </ul>
          {cloud ? (
            <>
              <Invitations onJoined={close} />
              <p><a href="/signup/organization" onClick={close}>New organization</a></p>
            </>
          ) : (
            <form
              className="form"
              onSubmit={(e) => {
                e.preventDefault();
                if (!other.trim()) return;
                close();
                navigate(pathIn(other.trim(), "tasks"));
              }}
            >
              <label htmlFor={otherId}>Sign in to another organization</label>
              <input id={otherId} value={other} onChange={(e) => setOther(e.target.value)} placeholder="Its name" autoComplete="off" />
            </form>
          )}
        </>
      )}
    </Disclosure>
  );
}

/** The pages and projects the command palette jumps to; the tasks are read when it opens. */
function jumpsOf(org: string, repos: RepoRecord[], me: Principal): Jump[] {
  const page = (label: string, detail: string, to: string): Jump => ({ label, detail, to, group: "Pages" });
  return [
    page("Work", "Sprint board and backlog", pathIn(org, "work")),
    page("Tasks", me.mode === "local" ? "Agent tasks and your folders" : "Agent tasks and the repositories they run in", pathIn(org, "tasks")),
    page("Team", me.mode === "local" ? "Lessons and what your Claude Code loads" : "People, policies and what the team shares", pathIn(org, "team")),
    page("Integrations", "Forges", pathIn(org, "integrations")),
    ...activityPagesFor(me).map((p) => page(p.label, "Account menu", pathIn(org, "activity", p.id))),
    page("Settings", manages(me) && me.mode !== "local" ? "Organization" : "Your account", pathIn(org, "settings")),
    ...settingsSectionsFor(me).map((sec) => page(sec.label, "Settings", pathIn(org, "settings", sec.id))),
    ...repos.map((r): Jump => ({ label: r.name, detail: me.mode === "local" ? "" : r.team, to: `${pathIn(org, "tasks")}?${new URLSearchParams({ repo: r.id })}`, group: me.mode === "local" ? "Folders" : "Repositories" })),
  ];
}

/**
 * The folders the palette lists for what was typed, on one person's own machine, as the folder picker
 * reads them: a path's folders, or a search. `~` is read against home, which the first list names.
 */
function folderJumps(org: string): (query: string) => Promise<Jump[]> {
  let home: string | null = null;
  return async (query) => {
    const ask = folderAsk(query);
    if (!ask) return [];
    home ??= (await projectsRead.folders()).under;
    const under = ask.under === undefined ? undefined : pastedPath(ask.under, home);
    const read = await projectsRead.folders({ ...(under ? { under } : {}), ...(ask.q ? { q: ask.q } : {}) });
    const prefix = ask.prefix?.toLowerCase() ?? "";
    const entries = ask.q ? (read.matches ?? read.folders) : read.folders.filter((f) => f.name.toLowerCase().startsWith(prefix));
    return entries.slice(0, MOST_A_GROUP).map((f): Jump => {
      const shown = homeRelative(f.path, home);
      return { label: shown, detail: f.git === "none" ? "" : "Git", to: `folder:${f.path}`, group: "Folders", inside: `${shown}/`, open: () => projectsRead.open(f.path).then(({ project }) => pathIn(org, "repositories", project.id)) };
    });
  };
}

/** The newest tasks, for the palette to jump to by title. */
function taskJumps(org: string, repos: RepoRecord[]): Promise<Jump[]> {
  const names = new Map(repos.map((r) => [r.id, r.name]));
  return tasksApi.page(null).then((p) => p.tasks.map((t): Jump => ({ label: t.title, detail: names.get(t.repoId) ?? "", to: pathIn(org, "tasks", t.id), group: "Tasks" })));
}

/**
 * A page with a search of its own marks its field with data-page-search; there Search and "/" put
 * the cursor in it, so the page never shows a second search. Everywhere else they open the palette.
 */
function pageSearch(): HTMLInputElement | null {
  return document.querySelector<HTMLInputElement>("main [data-page-search]");
}

/**
 * Ends the session this person signed in with. In the cloud that is one sign-in across every
 * organization, so it is ended there; an organization's own session would leave it standing.
 */
function signOut(me: Principal): Promise<unknown> {
  return me.mode === "cloud" ? identityApi.me().then((view) => identityApi.signOut(view.csrf)) : auth.logout();
}

/**
 * Whether this browser tells the person when a task of theirs needs them. The browser asks for
 * leave once; refused, the switch says where to give it, since only the browser can.
 */
function NotifySwitch() {
  const [notify, setNotify] = usePref(NOTIFY_KEY);
  const [blocked, setBlocked] = useState(() => "Notification" in window && Notification.permission === "denied");
  if (!("Notification" in window)) return null;
  const on = notify === "yes" && Notification.permission === "granted";
  const flip = () => {
    if (on) return setNotify(null);
    void Notification.requestPermission().then((answer) => {
      if (answer === "granted") setNotify("yes");
      setBlocked(answer === "denied");
    });
  };
  return (
    <div className="notify-switch">
      <label className="check"><input type="checkbox" checked={on} onChange={flip} />Notify me when my tasks need me</label>
      {blocked ? <p className="muted small">This browser blocks notifications from this page; allow them in its site settings.</p> : null}
    </div>
  );
}

const ASKED_KEY = "orchestrator.attention.asked";

/**
 * One line above the page until the browser has been asked, or the person said not now: the switch
 * lives in the account menu, where nobody who has not looked for it finds it.
 */
function NotifyAsk() {
  const [notify, setNotify] = usePref(NOTIFY_KEY);
  const [asked, setAsked] = usePref(ASKED_KEY);
  const [permission, setPermission] = useState(() => ("Notification" in window ? Notification.permission : "denied"));
  if (permission === "denied" || asked || (notify === "yes" && permission === "granted")) return null;
  const turnOn = () => {
    void Notification.requestPermission().then((answer) => {
      setPermission(answer);
      if (answer === "granted") setNotify("yes");
      else if (answer === "denied") setAsked("yes");
    });
  };
  return (
    <p className="notify-ask" role="region" aria-label="Notifications">
      Get a notification when a task needs you.
      <button type="button" className="small" onClick={turnOn}>Turn on notifications</button>
      <button type="button" className="ghost small" onClick={() => setAsked("yes")}>Not now</button>
    </p>
  );
}

function UserMenu({ me, org, onSignedOut }: { me: Principal; org: string; onSignedOut: () => void }) {
  const [theme, setTheme] = usePref(THEME_KEY);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!manages(me)) return;
    const read = () => api.onboarding().then((o) => setDismissed(o.dismissed), () => setDismissed(false));
    read();
    window.addEventListener(ONBOARDING_CHANGED, read);
    return () => window.removeEventListener(ONBOARDING_CHANGED, read);
  }, []);
  const pick = (t: Theme) => {
    setTheme(t === "system" ? null : t);
    applyTheme(t);
  };
  const role = `${me.role === "owner" ? "Owner" : me.role === "admin" ? "Admin" : "Member"}${me.ownedTeams.length ? `, owns ${me.ownedTeams.join(", ")}` : ""}`;
  return (
    <Disclosure label={`Account: ${me.name}`} summary={<span className="avatar" aria-hidden="true">{me.name.slice(0, 1).toUpperCase()}</span>} className="user-menu">
      {(close) => (
        <>
          <div className="who">
            <strong>{me.name}</strong>
            <span className="muted">{me.email}</span>
            {/* One person's own orchestrator has no roles to tell apart. */}
            {me.mode === "local" ? null : <span className="muted">{role}</span>}
          </div>
          <fieldset className="theme-pick">
            <legend>Theme</legend>
            {(["system", "light", "dark"] as Theme[]).map((t) => (
              <label key={t} className="check"><input type="radio" name="theme" checked={(theme ?? "system") === t} onChange={() => pick(t)} />{t === "system" ? "Match the system" : t === "light" ? "Light" : "Dark"}</label>
            ))}
          </fieldset>
          <NotifySwitch />
          <nav className="account-links" aria-label="Account">
            <a href={pathIn(org, "settings")} onClick={close}>Settings</a>
            <a href={pathIn(org, "activity", "news")} onClick={close}>What's new</a>
            {activityPageInMode(me, "usage") ? <a href={pathIn(org, "activity", "usage")} onClick={close}>Skill use over time</a> : null}
          </nav>
          {dismissed ? <button type="button" className="link" onClick={() => { void api.changeOnboarding({ dismissed: false }); close(); }}>Show the getting started guide</button> : null}
          <button type="button" className="secondary" onClick={() => signOut(me).finally(onSignedOut)}>Sign out</button>
        </>
      )}
    </Disclosure>
  );
}

export function Shell({ me, orgs, org, section, repos, onSignedOut, children }: { me: Principal; orgs: Org[]; org: string; section: Section | null; repos: RepoRecord[]; onSignedOut: () => void; children: ReactNode }) {
  const here = TABS.find((t) => t.section === section)?.label ?? "Sections";
  const [palette, setPalette] = useState(false);
  const jumps = useMemo(() => jumpsOf(org, repos, me), [org, repos, me]);
  const readTasks = useCallback(() => taskJumps(org, repos), [org, repos]);
  const readFolders = useMemo(() => (me.mode === "local" ? folderJumps(org) : undefined), [org, me.mode]);
  const search = useCallback((anywhere: boolean) => {
    const own = anywhere ? null : pageSearch();
    if (own) own.focus();
    else setPalette(true);
  }, []);
  return (
    <div className="shell">
      <a className="skip" href="#content">Skip to content</a>
      <header className="topbar">
        <a className="brand" href={pathIn(org, "tasks")}>TeamHandbook <span>Orchestrator</span></a>
        <OrgPicker me={me} orgs={orgs} org={org} section={section} />
        {/* A phone has no room for the sections in the bar; they gather into one menu named for where you are. */}
        <Disclosure label={`Sections: ${here}`} summary={<>{here} <span className="select-chevron" aria-hidden="true" /></>} className="section-menu">
          {(close) => (
            <ul className="plain">
              {TABS.map((t) => <li key={t.section}><a href={pathIn(org, t.section)} aria-current={t.section === section ? "page" : undefined} onClick={close}>{t.label}</a></li>)}
            </ul>
          )}
        </Disclosure>
        <nav className="tabs" aria-label="Orchestrator">
          {TABS.map((t) => (
            <a key={t.section} href={pathIn(org, t.section)} aria-current={t.section === section ? "page" : undefined}>{t.label}</a>
          ))}
        </nav>
        <div className="topbar-end">
          <button type="button" className="ghost search-button" onClick={() => search(false)} title="Search pages, projects and tasks (/ or Cmd/Ctrl+K)">Search <kbd>/</kbd></button>
          <UserMenu me={me} org={org} onSignedOut={onSignedOut} />
        </div>
      </header>
      <AttentionWatcher me={me} />
      <NotifyAsk />
      <Shortcuts org={org} tabs={TABS} onSearch={search} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} jumps={jumps} more={readTasks} {...(readFolders ? { folders: readFolders } : {})} />
      <main id="content" tabIndex={-1}>{children}</main>
    </div>
  );
}

/** The links under a section's title, for its own pages. */
export function SubNav({ label, links, current }: { label: string; links: { to: string; label: string }[]; current: string }) {
  const gathers = links.length > 5;
  const tabs = (
    <nav className={gathers ? "subnav subnav-gathers" : "subnav"} aria-label={label}>
      {links.map((l) => <a key={l.to} href={l.to} aria-current={l.to === current ? "page" : undefined}>{l.label}</a>)}
    </nav>
  );
  if (!gathers) return tabs;
  const open = links.find((l) => l.to === current)?.label ?? label;
  return (
    <>
      <Disclosure label={`${label}: ${open}`} summary={<>{open} <span className="select-chevron" aria-hidden="true" /></>} className="section-menu subnav-menu">
        {(close) => (
          <ul className="plain">
            {links.map((l) => <li key={l.to}><a href={l.to} aria-current={l.to === current ? "page" : undefined} onClick={close}>{l.label}</a></li>)}
          </ul>
        )}
      </Disclosure>
      {tabs}
    </>
  );
}
