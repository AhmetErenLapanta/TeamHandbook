import { useEffect, useId, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { manages, members, people } from "../api";
import type { InviteView, Principal, Role, SentInvite, TeamView, UserView } from "../api";
import { ConfirmAction, CopyText } from "../Confirm";
import { here } from "../router";
import { PAGE_SIZE, Pager, pageOf } from "../Pager";
import { Select } from "../Select";
import { Hint } from "../Hint";
import { LoadFailed, Loading } from "../Status";
import { PageHead } from "../design/PageHead";
import { TurnSection } from "../design/TurnSection";

export const ROLE_LABEL: Record<Role, string> = { owner: "Owner", admin: "Admin", member: "Member", viewer: "Viewer" };

/** How an account signs in, as a person reads it. */
const SIGN_IN_LABEL: Record<string, string> = { password: "Password", sso: "SSO", google: "Google", github: "GitHub", microsoft: "Microsoft" };
export const signInLabel = (ways: string[]) => ways.map((w) => SIGN_IN_LABEL[w] ?? w).join(", ") || "none";

export const ROLE_HINT: Record<Role, string> = {
  owner: "Full control: changes any role and removes any member.",
  admin: "Manages members, service accounts, repositories and settings.",
  member: "Reads every team and edits the teams they own.",
  viewer: "Reads every team's skills, tasks and requests and changes nothing; owns no team.",
};

const RANK: Record<Role, number> = { owner: 2, admin: 1, member: 0, viewer: -1 };

/** The roles this person may give: none above their own. The server decides; the screen offers only what it would accept. */
function grantable(me: Principal): Role[] {
  return (["owner", "admin", "member", "viewer"] as Role[]).filter((r) => RANK[r] <= RANK[me.role]);
}

function day(at: string): string {
  return new Date(at).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function TeamPicker({ teams, value, onChange, label, disabled }: { teams: TeamView[]; value: string[]; onChange: (v: string[]) => void; label: string; disabled?: boolean }) {
  if (!teams.length) return <span className="muted">No team yet</span>;
  return (
    <fieldset className="teams">
      <legend className="visually-hidden">{label}</legend>
      {teams.map((t) => (
        <label key={t.team} className="check">
          <input
            type="checkbox"
            checked={value.includes(t.team)}
            disabled={disabled}
            onChange={(e) => onChange(e.target.checked ? [...value, t.team] : value.filter((x) => x !== t.team))}
          />
          {t.team}
        </label>
      ))}
    </fieldset>
  );
}

export function SentLinks({ sent, skipped }: { sent: SentInvite[]; skipped: { email: string; reason: string }[] }) {
  return (
    <section className="panel" aria-labelledby="links-h">
      <h2 id="links-h">Links to send</h2>
      {sent.length ? (
        <>
          <p>Send each person their link: it works once, for 7 days, and is not shown again. <Hint label="invitation links">The orchestrator sends no email, so the link reaches them only from you.</Hint></p>
          <ul className="plain">
            {sent.map((i) => (
              <li key={i.id}>
                {i.email}: <CopyText text={i.link} label={`Copy the link for ${i.email}`} />
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {skipped.map((s) => <p key={s.email} className="muted">{s.email}: {s.reason}</p>)}
    </section>
  );
}

/** Addresses as people type or paste them: separated by spaces, commas, semicolons or lines. */
const SEPARATOR = /[\s,;]+/;

export function InviteForm({ me, teams, onSent, onCancel }: { me: Principal; teams: TeamView[]; onSent: (sent: SentInvite[], skipped: { email: string; reason: string }[]) => void; onCancel?: () => void }) {
  const [emails, setEmails] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [role, setRole] = useState<Role>("member");
  const [owned, setOwned] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = useId();
  const hintId = useId();
  const add = (more: string[]) => setEmails((had) => [...had, ...more.filter((e, n) => e && !had.includes(e) && more.indexOf(e) === n)]);
  // Each finished address becomes its own entry; what follows the last separator is still being typed.
  const type = (text: string) => {
    const parts = text.split(SEPARATOR);
    setDraft(parts.pop() ?? "");
    add(parts);
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const all = [...emails, ...draft.split(SEPARATOR).filter((x) => x && !emails.includes(x))];
    setBusy(true);
    setError(null);
    members.invite({ emails: all.join(" "), role, teams: role === "viewer" ? [] : owned }).then(
      (r) => {
        setEmails([]);
        setDraft("");
        setOwned([]);
        setBusy(false);
        onSent(r.invited, r.skipped);
      },
      (err: Error) => {
        setError(err.message);
        setBusy(false);
      },
    );
  };
  const described = error ? { "aria-describedby": errorId } : {};
  return (
    <form className="form" onSubmit={submit} aria-labelledby="invite-h">
      <h2 id="invite-h">Invite members</h2>
      {emails.length ? (
        <ul className="plain actions" aria-label="Addresses to invite">
          {emails.map((e) => (
            <li key={e} className="badge">
              {e} <button type="button" className="ghost small" aria-label={`Leave out ${e}`} onClick={() => setEmails(emails.filter((x) => x !== e))}>×</button>
            </li>
          ))}
        </ul>
      ) : null}
      <label>
        Emails
        <input
          value={draft}
          onChange={(e) => type(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && draft.trim()) {
              e.preventDefault();
              type(`${draft} `);
            } else if (e.key === "Backspace" && !draft && emails.length) setEmails(emails.slice(0, -1));
          }}
          required={!emails.length}
          autoComplete="off"
          spellCheck={false}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        />
      </label>
      <p className="muted" id={hintId}>Separate addresses with spaces, commas or new lines.</p>
      <fieldset>
        <legend>Role</legend>
        {grantable(me).map((r) => (
          <label key={r} className="check"><input type="radio" name="invite-role" value={r} checked={role === r} onChange={() => setRole(r)} {...described} /> {ROLE_LABEL[r]}</label>
        ))}
      </fieldset>
      <p className="muted">{ROLE_HINT[role]}</p>
      {role === "viewer" ? null : (
        <div>
          <span>Team owner of</span>
          <TeamPicker teams={teams} value={owned} onChange={setOwned} label="Teams they will own" />
        </div>
      )}
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      <div className="actions">
        <button type="submit" disabled={busy}>Create invitation links</button>
        {onCancel ? <button type="button" className="secondary" onClick={onCancel} disabled={busy}>Cancel</button> : null}
      </div>
    </form>
  );
}

/**
 * The invitations nobody has taken up yet, one row each. A row is picked, and the picked one's
 * Resend and Revoke show once below the list, never on every row.
 */
function PendingInvites({ invites, me, hideEmpty = false, onChanged, onLink }: { invites: InviteView[]; me: Principal; hideEmpty?: boolean; onChanged: () => void; onLink: (sent: SentInvite) => void }) {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (hideEmpty && !invites.length) return null;
  const chosen = invites.find((i) => i.id === picked) ?? null;
  const act = (run: Promise<unknown>) => run.then(onChanged, (err: Error) => setError(err.message));
  return (
    <TurnSection name="Invitations" count={invites.length} why="Each waits for its person to open the link they were sent." empty="No invitation waits; Invite members makes links to send.">
      {error ? <p className="error" role="alert">{error}</p> : null}
      <table className="member-table row-cards">
        <colgroup><col className="c-who" /><col className="c-role" /><col className="c-teams" /><col className="c-when" /><col className="c-way" /></colgroup>
        <thead className="visually-hidden"><tr><th>Email</th><th>Role</th><th>Team owner of</th><th>Expires</th><th>Invited by</th></tr></thead>
        <tbody>
          {invites.map((i) => (
            <tr key={i.id} className={i.id === picked ? "picked" : undefined} onClick={() => setPicked(i.id)}>
              <td className="rc-title"><button type="button" className="row-pick" aria-pressed={i.id === picked} onClick={() => setPicked(i.id)}>{i.email}</button></td>
              <td className="rc-status">{ROLE_LABEL[i.role]}</td>
              <td className={i.teams.length ? "rc-meta" : "rc-meta muted member-wide-only"}>{i.teams.length ? <><span className="member-cell-label">Owns </span><span>{i.teams.join(", ")}</span></> : "none"}</td>
              <td className="rc-meta">{i.expired ? <span className="badge warn">expired</span> : <><span className="member-cell-label">Expires </span>{day(i.expiresAt)}</>}</td>
              <td className="rc-extra muted">{i.invitedBy}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {chosen && RANK[chosen.role] <= RANK[me.role] ? (
        <div className="actions row-line">
          <button type="button" className="secondary" aria-label={`Resend the invitation to ${chosen.email}`} onClick={() => act(members.resend(chosen.id).then(onLink))}>Resend the link</button>
          <ConfirmAction
            trigger="Revoke…"
            triggerLabel={`Revoke the invitation to ${chosen.email}`}
            consequence={`The link sent to ${chosen.email} stops working at once.`}
            confirm="Revoke invitation"
            keep="Keep invitation"
            onConfirm={() => members.revoke(chosen.id).then(() => {
              setPicked(null);
              onChanged();
            })}
          />
        </div>
      ) : chosen ? null : <p className="muted small row-line">Pick an invitation to resend or revoke it.</p>}
    </TurnSection>
  );
}

/** The teams a member owns, changed only by Edit and then Save, so a stray click gives or takes no one's access. */
function Ownership({ user, teams, editable, onSave }: { user: UserView; teams: TeamView[]; editable: boolean; onSave: (teams: string[]) => Promise<unknown> }) {
  const [editing, setEditing] = useState<string[] | null>(null);
  if (!editing) {
    return (
      <div className="row-actions">
        <span>{user.ownedTeams.join(", ") || <span className="muted">none</span>}</span>
        {editable && teams.length ? <button type="button" className="secondary small" aria-label={`Edit the teams ${user.email} owns`} onClick={() => setEditing(user.ownedTeams)}>Edit</button> : null}
      </div>
    );
  }
  return (
    <>
      <TeamPicker teams={teams} value={editing} onChange={setEditing} label={`Teams ${user.email} owns`} />
      <div className="row-actions">
        <button type="button" className="small" aria-label={`Save the teams ${user.email} owns`} onClick={() => onSave(editing).then(() => setEditing(null), () => undefined)}>Save</button>
        <button type="button" className="secondary small" onClick={() => setEditing(null)}>Cancel</button>
      </div>
    </>
  );
}

/**
 * What can be changed about one member, on their own page: their role, the teams they own, and
 * removing them. Nobody changes their own role or touches a role above their own.
 */
export function MemberAccess({ user, me, onChanged, onRemoved }: { user: UserView; me: Principal; onChanged: () => void; onRemoved: () => void }) {
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  useEffect(() => {
    people.teams().then(setTeams, () => setTeams([]));
  }, []);
  const update = (input: Parameters<typeof people.update>[1]) => people.update(user.id, input).then(onChanged, (err: Error) => {
    setError(err.message);
    throw err;
  });
  const reach = manages(me) && RANK[user.role] <= RANK[me.role];
  const roleFixed = user.id === me.id || !reach;
  return (
    <>
      <div>
        <Select
          label={`Role of ${user.email}`}
          describedBy={error ? errorId : undefined}
          value={user.role}
          disabled={roleFixed}
          onChange={(v) => void update({ role: v as Role }).catch(() => undefined)}
          options={(["owner", "admin", "member", "viewer"] as Role[]).filter((r) => r === user.role || grantable(me).includes(r)).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
        />
        <p className="muted">{user.id === me.id ? "Nobody changes their own role." : ROLE_HINT[user.role]}</p>
      </div>
      <div>
        <p className="label">Team owner of</p>
        <Ownership user={user} teams={teams} editable={reach} onSave={(t) => update({ teams: t })} />
      </div>
      {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      {user.id !== me.id && reach ? (
        <ConfirmAction
          trigger={`Remove ${user.name}`}
          triggerLabel={`Remove ${user.email}`}
          consequence={`${user.email} loses access at once: their sessions end and their API keys stop working. The requests and tasks they started stay with their teams.`}
          confirm="Remove member"
          keep="Keep member"
          onConfirm={() => people.remove(user.id).then(onRemoved)}
        />
      ) : null}
    </>
  );
}

/** One member in the list: who they are and what they hold; their role is the one value changed in the row, the rest on their own page. */
function MemberRow({ user, me, onChanged, extra }: { user: UserView; me: Principal; onChanged: () => void; extra?: { name: string; cell: ReactNode } }) {
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  // Nobody changes their own role or touches a role above their own.
  const roleFixed = user.id === me.id || RANK[user.role] > RANK[me.role];
  return (
    <tr>
      <td className="rc-title">
        <a href={here("settings", "members", user.id)}>{user.name}</a>{user.id === me.id ? <span className="muted"> (you)</span> : null}
        <div className="muted">{user.email}</div>
      </td>
      <td className="rc-status">
        <Select
          label={`Role of ${user.email}`}
          labelHidden
          describedBy={error ? errorId : undefined}
          value={user.role}
          disabled={roleFixed}
          onChange={(v) => people.update(user.id, { role: v as Role }).then(onChanged, (err: Error) => setError(err.message))}
          options={(["owner", "admin", "member", "viewer"] as Role[]).filter((r) => r === user.role || grantable(me).includes(r)).map((r) => ({ value: r, label: ROLE_LABEL[r] }))}
        />
        {error ? <p className="error" role="alert" id={errorId}>{error}</p> : null}
      </td>
      <td className={user.ownedTeams.length ? "rc-meta" : "rc-meta muted member-wide-only"}>{user.ownedTeams.length ? <><span className="member-cell-label">Owns </span><span>{user.ownedTeams.join(", ")}</span></> : "none"}</td>
      <td className="rc-meta"><span className="member-cell-label">Joined </span>{day(user.createdAt)}</td>
      <td className="rc-meta">{signInLabel(user.signIn)}</td>
      {extra ? <td className="rc-meta"><span className="member-cell-label">{extra.name}: </span>{extra.cell}</td> : null}
    </tr>
  );
}

/** What a member sees under Members: who owns each team, so they know whom to ask, and their own page. */
function TeamsReadOnly({ me, onLeft }: { me: Principal; onLeft: () => void }) {
  const [teams, setTeams] = useState<TeamView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => people.teams().then(setTeams, (e: Error) => setError(e.message));
  useEffect(() => {
    void load();
  }, []);
  return (
    <>
      <section className="panel" aria-labelledby="teams-h">
        <h2 id="teams-h">Teams {teams ? <span className="count">{teams.length}</span> : null}</h2>
        <p className="muted">You read every team{me.ownedTeams.length ? ` and are team owner of ${me.ownedTeams.join(", ")}` : ""}; <a href={here("settings", "members", me.id)}>open your own member page</a>. <Hint label="teams">A team's owners edit its skills, MCP servers and commands; an owner or an admin manages members.</Hint></p>
        {error ? <LoadFailed what="teams" reason={error} onRetry={() => { setError(null); void load(); }} /> : !teams ? <Loading what="teams" /> : teams.length ? (
          <table>
            <thead><tr><th>Team</th><th>Team owners</th><th>Repositories</th></tr></thead>
            <tbody>
              {teams.map((t) => (
                <tr key={t.team}>
                  <td>{t.team}</td>
                  <td>{t.owners.map((o) => o.name).join(", ") || <span className="muted">none yet</span>}</td>
                  <td>{t.repos.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : <p className="muted">No team yet.</p>}
      </section>
      <LeaveOrganization me={me} onLeft={onLeft} />
    </>
  );
}

/** Leaving on one's own. An owner is told why they cannot, before they try. */
export function LeaveOrganization({ me, onLeft }: { me: Principal; onLeft: () => void }) {
  return (
    <section className="panel" aria-labelledby="leave-h">
      <h2 id="leave-h">Leave the organization</h2>
      {me.role === "owner" ? (
        <p className="muted">Make another member an owner first; then you can leave.</p>
      ) : (
        <ConfirmAction
          trigger="Leave…"
          consequence="You lose access to every team here at once. An owner or an admin invites you again if you need to come back."
          confirm="Leave the organization"
          keep="Stay"
          onConfirm={() => members.leave().then(onLeft)}
        />
      )}
    </section>
  );
}

const ROLE_SECTIONS: { role: Role; name: string; empty: string }[] = [
  { role: "owner", name: "Owners", empty: "No owner." },
  { role: "admin", name: "Admins", empty: "No admin yet; an owner makes one by changing a member's role." },
  { role: "member", name: "Members", empty: "No member yet; invite the people who work on your team's skills." },
  { role: "viewer", name: "Viewers", empty: "No viewer yet; a viewer reads every team and changes nothing." },
];

const counted = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The organization's members and the invitations not taken up yet, as a page that manages them reads them, read again after each change. */
export function useMembers(me: Principal) {
  const [users, setUsers] = useState<UserView[] | null>(null);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [invites, setInvites] = useState<InviteView[]>([]);
  const [sent, setSent] = useState<{ sent: SentInvite[]; skipped: { email: string; reason: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [invitesError, setInvitesError] = useState<string | null>(null);
  const managing = manages(me);
  const reload = () => {
    if (!managing) return;
    setError(null);
    setInvitesError(null);
    people.users().then(setUsers, (e: Error) => setError(e.message));
    people.teams().then(setTeams, () => setTeams([]));
    members.invites().then(setInvites, (e: Error) => setInvitesError(e.message));
  };
  useEffect(reload, [managing]);
  return { users, teams, invites, sent, setSent, error, invitesError, reload };
}

export type MembersData = ReturnType<typeof useMembers>;

/**
 * The members cut by role, each row's role its one control, then the invitations nobody has taken
 * up. The page around them draws its own head; `extra` adds one cell to each member's row, under its name.
 */
export function MembersSections({ me, data, extra, hideEmpty = false }: { me: Principal; data: MembersData; extra?: { name: string; cell: (user: UserView) => ReactNode }; hideEmpty?: boolean }) {
  const [find, setFind] = useState("");
  const [page, setPage] = useState(1);
  const { users, invites, sent, setSent, error, invitesError, reload } = data;
  const needle = find.trim().toLowerCase();
  const matching = (users ?? []).filter((u) => !needle || u.name.toLowerCase().includes(needle) || u.email.toLowerCase().includes(needle));
  const shown = pageOf(matching, page);
  const columns = ["Member", "Role", "Team owner of", "Joined", "Signs in with", ...(extra ? [extra.name] : [])];
  const wide = extra ? " with-extra" : "";
  return (
    <>
      {sent ? <SentLinks sent={sent.sent} skipped={sent.skipped} /> : null}
      {error ? <LoadFailed what="members" reason={error} onRetry={reload} /> : !users ? <Loading what="members" /> : (
        <>
          {users.length > PAGE_SIZE ? (
            <label className="filter">
              Find a member
              <input type="search" data-page-search value={find} onChange={(e) => {
                setFind(e.target.value);
                setPage(1);
              }} />
            </label>
          ) : null}
          {needle && !matching.length ? <p className="muted">No one matches “{find.trim()}”.</p> : null}
          <div className="turn-columns member-head" aria-hidden="true"><span /><span className={`member-columns${wide}`}>{columns.map((c) => <span key={c}>{c}</span>)}</span></div>
          {ROLE_SECTIONS.map(({ role, name, empty }) => {
            const rows = shown.shown.filter((u) => u.role === role);
            if (hideEmpty && !needle && !matching.some((u) => u.role === role)) return null;
            return (
              <TurnSection key={role} name={name} count={matching.filter((u) => u.role === role).length} why={ROLE_HINT[role]} empty={needle ? `No one here matches “${find.trim()}”.` : empty}>
                {rows.length ? (
                  <table className={`member-table row-cards${wide}`}>
                    <colgroup><col className="c-who" /><col className="c-role" /><col className="c-teams" /><col className="c-when" /><col className="c-way" />{extra ? <col className="c-extra" /> : null}</colgroup>
                    <thead className="visually-hidden"><tr>{columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                    <tbody>{rows.map((u) => <MemberRow key={u.id} user={u} me={me} onChanged={reload} extra={extra ? { name: extra.name, cell: extra.cell(u) } : undefined} />)}</tbody>
                  </table>
                ) : <p className="turn-empty">On another page of this list.</p>}
              </TurnSection>
            );
          })}
          <Pager page={shown.page} total={matching.length} onPage={setPage} label="Pages of members" />
        </>
      )}
      {invitesError ? <LoadFailed what="invitations" reason={invitesError} onRetry={reload} /> : <PendingInvites invites={invites} me={me} hideEmpty={hideEmpty} onChanged={reload} onLink={(i) => setSent({ sent: [i], skipped: [] })} />}
    </>
  );
}

/** Who is in the organization, cut by role, with whom it waits on: the invitations not taken up yet. */
export function MembersSettings({ me, nav, onLeft }: { me: Principal; nav: ReactNode; onLeft: () => void }) {
  const data = useMembers(me);
  const [inviting, setInviting] = useState(false);
  if (!manages(me)) {
    return (
      <>
        <PageHead title="Members" summary="Who owns each team, so you know whom to ask." />
        {nav}
        <TeamsReadOnly me={me} onLeft={onLeft} />
      </>
    );
  }
  const { users, invites } = data;
  const summary = users ? `${counted(users.length, "person", "people")} in this organization${invites.length ? `; ${counted(invites.length, "invitation waits", "invitations wait")} to be taken up` : ""}.` : undefined;
  return (
    <>
      <PageHead title="Members" summary={summary} actions={inviting ? null : <button type="button" onClick={() => setInviting(true)}>Invite members</button>} />
      {nav}
      {inviting ? (
        <section className="panel">
          <InviteForm me={me} teams={data.teams} onCancel={() => setInviting(false)} onSent={(s, skipped) => {
            data.setSent({ sent: s, skipped });
            setInviting(false);
            data.reload();
          }} />
        </section>
      ) : null}
      <MembersSections me={me} data={data} />
      <LeaveOrganization me={me} onLeft={onLeft} />
    </>
  );
}
