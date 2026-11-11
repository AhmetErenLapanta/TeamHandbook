/**
 * What reaches a running task after it started: a person's follow-up, what a watch on its
 * request saw, that a task it delegated ended, or what a teammate reviewing its request suggested.
 * Each is kept before it is delivered, under a key its source gives, so a second
 * web node or a sweep that restarted writes it once; the text is masked before it is kept.
 */
export type FollowUpSource = "person" | "watch" | "child" | "reviewer";
/**
 * A reviewer's follow-up is kept `proposed` and reaches no agent: the task runs with its starter's
 * whole setup, so only the starter's Continue makes it `pending`, and their Dismiss makes it `dismissed`.
 */
export type FollowUpStatus = "proposed" | "pending" | "delivered" | "closed" | "dismissed";

/** A passage the follow-up points at: a file, its lines, and the text quoted from them. */
export interface FollowUpQuote {
  path: string;
  lines: string;
  text: string;
}

export interface FollowUpRecord {
  tenant: string;
  id: string;
  taskId: string;
  source: FollowUpSource;
  key: string;
  text: string;
  quotes: FollowUpQuote[] | null;
  status: FollowUpStatus;
  createdAt: string;
  deliveredAt: string | null;
  createdBy: string;
}

export type NewFollowUp = Omit<FollowUpRecord, "status" | "deliveredAt">;

export interface FollowUpStore {
  /** Keeps a follow-up once per task and key, a reviewer's as proposed; `created` is false when it was already kept, and that one comes back. One that looks like it holds a secret is refused. */
  addFollowUp(followUp: NewFollowUp): Promise<{ created: boolean; followUp: FollowUpRecord }>;
  /** The task's follow-ups not delivered yet, oldest first. */
  pendingFollowUps(tenant: string, taskId: string): Promise<FollowUpRecord[]>;
  /** Every follow-up of the task, whatever came of it, oldest first. */
  taskFollowUps(tenant: string, taskId: string): Promise<FollowUpRecord[]>;
  /** Marks these pending follow-ups delivered; says how many were. */
  markFollowUpsDelivered(tenant: string, ids: readonly string[], at: string): Promise<number>;
  /** The task ended: its follow-ups still pending are closed and no longer delivered; says how many. */
  closeFollowUps(tenant: string, taskId: string, at: string): Promise<number>;
  /** How many follow-ups from these sources reached each of these tasks; a task none reached is left out. */
  deliveredFollowUpCounts(tenant: string, taskIds: readonly string[], sources: readonly FollowUpSource[]): Promise<Map<string, number>>;
  /** The starter's answer to a proposed follow-up: true when it was still proposed and is now `to`, so a second click answers nothing. */
  answerFollowUp(tenant: string, taskId: string, id: string, to: "pending" | "dismissed"): Promise<boolean>;
  /** Every reviewer's follow-up on these tasks, oldest first. */
  reviewerFollowUps(tenant: string, taskIds: readonly string[]): Promise<FollowUpRecord[]>;
  /**
   * Which of these tasks wait on their starter to follow up while the task's request is open: a teammate's proposed
   * follow-up, or a check that broke, a comment or a conflict the request watch queued, which runs only when they go on.
   */
  waitingSuggestionTasks(tenant: string, taskIds: readonly string[]): Promise<Set<string>>;
}
