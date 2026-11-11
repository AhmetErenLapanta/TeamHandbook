/** What changed in the orchestrator, newest first; the overview shows the newest until it is dismissed. */
export interface NewsItem { id: string; title: string; body: string; link?: { section: string; page?: string; label: string } }

export const WHATS_NEW: NewsItem[] = [
  {
    id: "2026-11-four-sections",
    title: "Work, Tasks, Team and Integrations",
    body: "The orchestrator opens on Tasks. Your repositories are the list on its left, each one's settings a panel from there, and Controls is now Team. Settings, What's new and skill use moved to your account menu. Old links still open the page they used to.",
    link: { section: "tasks", label: "Go to Tasks" },
  },
  {
    id: "2026-10-sections",
    title: "Activity, Repositories, Tasks, Controls, Integrations and Settings",
    body: "The orchestrator's pages now sit under six tabs at the top, inside your organization. Old links still open the page they used to. Forge access moved to Integrations, and people to Settings.",
    link: { section: "activity", page: "usage", label: "See skill use over time" },
  },
];
