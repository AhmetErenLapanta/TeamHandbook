import { manages } from "../api";
import type { Principal } from "../api";
import { NotFoundPage } from "../NotFound";
import { SETTINGS_SECTIONS, settingsSectionInMode, settingsSectionsFor } from "../navigation";
import { here, placeOf } from "../router";
import { SubNav } from "../Shell";
import { AccountSettings } from "./Account";
import { AgentReadinessSettings } from "./AgentReadiness";
import { AccessSettings } from "./Access";
import { CodeLivesSettings } from "./CodeLives";
import { ApiKeysSettings } from "./Keys";
import { MemberView } from "./Member";
import { MachinesSettings } from "./Machines";
import { MembersSettings } from "./Members";
import { OrganizationSettings } from "./Organization";
import { PrivacySettings } from "./Privacy";
import { SecuritySettings } from "./Security";
import { ServiceAccountsSettings } from "./ServiceAccounts";
import { TaskLimitsSettings } from "./TaskLimits";
import { TaskSecretsSettings } from "./TaskSecrets";
import { UpdatesSettings } from "./Updates";

/** Settings, one section at a time, under `/<org>/settings/<section>[/<id>]` like every other top section. */
export function SettingsView({ me, route, onLeft }: { me: Principal; route: string; onLeft: () => void }) {
  // Settings opens on one's own account in both experiences.
  const [, section = "account", id] = route.split("/").filter(Boolean);
  const current = SETTINGS_SECTIONS.find((s) => s.id === section && settingsSectionInMode(me, s.id));
  if (!current) return <NotFoundPage org={placeOf(window.location.pathname).org ?? ""} path={window.location.pathname} />;
  const to = (part: string) => here("settings", part);
  const shown = settingsSectionsFor(me);
  const nav = <SubNav label="Settings" current={to(current.id)} links={shown.map((s) => ({ to: to(s.id), label: s.label }))} />;
  if (current.id === "members" && id) return <div className="page"><MemberView id={id} me={me} nav={nav} /></div>;
  if (current.id === "members") return <div className="page"><MembersSettings me={me} nav={nav} onLeft={onLeft} /></div>;
  if (current.id === "account") return <div className="page"><AccountSettings me={me} nav={nav} onChanged={onLeft} /></div>;
  return (
    <div className="page">
      <header className="page-head"><h1>{current.label}</h1></header>
      {nav}
      {current.id === "code" ? <CodeLivesSettings me={me} /> : null}
      {current.id === "task-limits" ? <TaskLimitsSettings me={me} /> : null}
      {current.id === "service-accounts" ? <ServiceAccountsSettings me={me} /> : null}
      {current.id === "api-keys" ? <ApiKeysSettings me={me} /> : null}
      {current.id === "access" ? <AccessSettings me={me} /> : null}
      {current.id === "task-secrets" ? <TaskSecretsSettings me={me} /> : null}
      {current.id === "agents" ? <AgentReadinessSettings /> : null}
      {current.id === "machines" ? <MachinesSettings /> : null}
      {current.id === "security" ? <SecuritySettings me={me} /> : null}
      {current.id === "privacy" ? <PrivacySettings me={me} /> : null}
      {current.id === "organization" ? <OrganizationSettings me={me} /> : null}
      {current.id === "updates" ? <UpdatesSettings /> : null}
    </div>
  );
}
