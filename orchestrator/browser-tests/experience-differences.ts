/**
 * Where Personal and Team may differ on a main screen or a route. The structure test compares each main
 * screen and every route either experience offers, and a difference not named here is one the person was
 * not meant to meet. The design document names this file; its entries are the design owner's to keep.
 * `item` is a section's or region's visible name, or a route's path below the organization.
 */
export type ExperienceScreen = "work" | "tasks" | "task" | "team" | "integrations" | "settings" | "route";

export interface ExperienceDifference {
  screen: ExperienceScreen;
  only: "personal" | "team";
  item: string;
  why: string;
}

export const EXPERIENCE_DIFFERENCES: ExperienceDifference[] = [
  { screen: "task", only: "personal", item: "alpha", why: "Nouns that say whose or where: a Personal task works in a folder, so its change sits under the repository's name; a Team task works in one repository" },
  { screen: "team", only: "team", item: "Automations", why: "Other computers: a tracker's changes reach a shared server, not one person's own computer" },
  { screen: "team", only: "team", item: "Owners", why: "Other people: a Personal orchestrator has one person" },
  { screen: "team", only: "team", item: "Admins", why: "Other people" },
  { screen: "team", only: "team", item: "Members", why: "Other people" },
  { screen: "team", only: "team", item: "Viewers", why: "Other people" },
  { screen: "team", only: "team", item: "Invitations", why: "Other people" },
  { screen: "settings", only: "personal", item: "Updates", why: "This computer: a Team server is updated where it is deployed" },
  { screen: "settings", only: "personal", item: "Your data", why: "Signing in and the organization: Personal has no account to delete, so it says where its data lives" },
  { screen: "settings", only: "team", item: "Delete your account", why: "Signing in and the organization" },
  { screen: "settings", only: "team", item: "Members", why: "Signing in and the organization" },
  { screen: "settings", only: "team", item: "Service accounts", why: "Signing in and the organization" },
  { screen: "settings", only: "team", item: "API keys", why: "Signing in and the organization: keys belong to signed-in people" },
  { screen: "settings", only: "team", item: "Access", why: "Signing in and the organization: where a person is signed in" },
  { screen: "settings", only: "team", item: "Your machines", why: "Other computers: machines connect to a shared server" },
  { screen: "settings", only: "team", item: "Security", why: "Signing in and the organization: single sign-on and provisioning" },
  { screen: "settings", only: "team", item: "Organization", why: "Signing in and the organization" },
  { screen: "route", only: "personal", item: "settings/updates", why: "This computer" },
  { screen: "route", only: "team", item: "activity/usage", why: "Other people: skill use teammates' machines report, and tasks by person" },
  { screen: "route", only: "team", item: "settings/access", why: "Signing in and the organization" },
  { screen: "route", only: "team", item: "settings/api-keys", why: "Signing in and the organization" },
  { screen: "route", only: "team", item: "settings/machines", why: "Other computers" },
  { screen: "route", only: "team", item: "settings/members", why: "Signing in and the organization" },
  { screen: "route", only: "team", item: "settings/organization", why: "Signing in and the organization" },
  { screen: "route", only: "team", item: "settings/security", why: "Signing in and the organization" },
  { screen: "route", only: "team", item: "settings/service-accounts", why: "Signing in and the organization" },
];
