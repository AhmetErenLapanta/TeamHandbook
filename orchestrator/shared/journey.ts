/** The steps an organization goes through to get set up, in order. */
export type MilestoneId = "org" | "forge" | "repo" | "invited" | "joined" | "tracker" | "task" | "request" | "merged";

/**
 * Whether the organization has reached a step, and when and by whom it first did. A step reached
 * before the log kept it, such as a repository the configuration file lists, is done with no time.
 */
export interface Milestone { id: MilestoneId; done: boolean; at: string | null; by: string | null }

/** How far one person has gone, the furthest thing they did. */
export type Stage = "joined" | "started a task" | "opened a request" | "merged a request";

/**
 * One person in this organization: when they joined it, their first task and first request in it,
 * and the furthest of those. Nothing they did in another organization, nor how they signed up.
 */
export interface PersonStage {
  id: string;
  name: string;
  email: string;
  role: "owner" | "admin" | "member" | "viewer";
  stage: Stage;
  since: string;
  joinedAt: string;
  firstTaskAt: string | null;
  firstRequestAt: string | null;
  lastSeen: string | null;
}

/** Who is where: the organization's steps, its people, and the invitations still waiting, oldest first. */
export interface Journey {
  milestones: Milestone[];
  people: PersonStage[];
  invited: { email: string; at: string; expiresAt: string }[];
}
