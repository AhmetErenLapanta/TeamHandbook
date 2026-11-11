import type { RequestStatus } from "./activity.js";
import { FORGES, HOSTED_FORGES } from "./forge-def.js";
import type { ForgeCapabilities, HostedForge } from "./forge-def.js";

/**
 * What the orchestrator reads of a request before anyone merges it, the same shape for every forge,
 * and what each forge can say: the server reads it, the screen shows it, both from these types.
 */

export type { ForgeCapabilities, HostedForge };

/** Each forge's capabilities, as its definition gives them. */
export const CAPABILITIES = Object.fromEntries(HOSTED_FORGES.map((kind) => [kind, FORGES[kind].capabilities])) as Record<HostedForge, ForgeCapabilities>;

export type CheckState = "success" | "failure" | "pending" | "skipped";

export interface RequestCheck {
  name: string;
  /** What ran it: a GitHub app, GitLab's pipeline or an outside status; two checks of one name in two groups are two checks. */
  group: string;
  state: CheckState;
  url: string | null;
}

export interface ChecksSummary {
  state: "passing" | "failing" | "pending" | "no-ci" | "unknown";
  /** Failures first, then what is still running, then the rest, each by name. */
  checks: RequestCheck[];
}

export interface ReviewSummary {
  decision: "approved" | "changes-requested" | "pending" | "none";
  approvedBy: string[];
}

export interface Mergeability {
  state: "mergeable" | "conflict" | "blocked" | "checking" | "not-open";
  /** What holds a blocked request, in the forge's own term turned into words. */
  reason: string | null;
}

export interface RequestDetail {
  number: number;
  status: RequestStatus;
  headSha: string;
  /** The branch it merges into, as the forge has it now: a target changed on the forge shows here. Absent where the forge did not say. */
  target?: string;
  mergeability: Mergeability;
  review: ReviewSummary;
  checks: ChecksSummary;
}

/**
 * One thing a person said on a request, on a line of a file when `path` is set. Written by whoever
 * reviews, so it is text to show and, for an agent, data to read, never an instruction to follow.
 */
export interface RequestComment {
  id: string;
  author: string;
  /** A bot is an app's or a forge's own account, a CI reporter or a dependency updater; a person is anyone else. */
  kind: "person" | "bot";
  body: string;
  at: string;
  path: string | null;
  line: number | null;
  url: string | null;
}

/**
 * What a watch of a request reads each time: its detail, what people said on it, newest first, and
 * a fingerprint of the two that changes when anything a watcher acts on does.
 */
export interface RequestWatch {
  detail: RequestDetail;
  comments: RequestComment[];
  fingerprint: string;
}

/**
 * Where a request stands as a person's screen reads it, whichever forge it is on: what a watch
 * reads, from the forge, or, for one on the orchestrator's local forge, from the repository itself,
 * where no CI, review or comment exists. `capabilities` is null for the local forge.
 */
export interface RequestStatusRead extends RequestWatch {
  source: "forge" | "local";
  capabilities: ForgeCapabilities | null;
}

