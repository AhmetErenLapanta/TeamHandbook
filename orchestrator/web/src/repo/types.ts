import type { Inventory, JoinMessage, Principal, RepoRecord, RequestRecord, ScaffoldRefresh, SkillOverlap, UsageCount } from "../api";

/** What every panel of a repository's page is given by the page around it. */
export interface RepoPanelProps {
  repo: RepoRecord;
  data: { inventory: Inventory; join: JoinMessage; refresh: ScaffoldRefresh };
  me: Principal;
  /** Whether this person may propose changes here, and the repository is still in the configuration. */
  editable: boolean;
  usage: { days: number; usage: UsageCount[]; shown: boolean } | null;
  overlaps: Record<string, SkillOverlap> | null;
  /** Reads the repository again, after a request was merged or closed from a panel. */
  onChanged: () => void;
  /** A request a panel opened; the page says so, with `notice` in place of its usual words. */
  onOpened: (request: RequestRecord, notice?: string) => void;
  /** The file or folder whose history the page shows, and how a panel picks one. */
  selected: string | undefined;
  onSelect: (path: string) => void;
  /** Goes up each time the page reads the repository's requests again, so a list of them follows. */
  requestsRead: number;
}
