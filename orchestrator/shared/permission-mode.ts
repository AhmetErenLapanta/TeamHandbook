/** How much an agent does on its own, least first: each mode allows everything the one before it does. */
export const PERMISSION_MODES = ["approval-required", "auto-accept-edits", "auto", "full-access"] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

export const MODE_LABEL: Record<PermissionMode, string> = {
  "approval-required": "Approval required",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

/** What each mode lets the agent do without asking, as the screen says it. */
export const MODE_MEANS: Record<PermissionMode, string> = {
  "approval-required": "asks before every edit and command",
  "auto-accept-edits": "edits files on its own and asks before a command",
  auto: "edits and runs the commands its rules allow without asking",
  "full-access": "runs anything in its sandbox without asking; its work still ends in a request someone reviews",
};

/** The mode a task runs in when nobody chose one: what agents did before modes existed. */
export const DEFAULT_MODE: PermissionMode = "auto";

export const isPermissionMode = (value: unknown): value is PermissionMode => typeof value === "string" && (PERMISSION_MODES as readonly string[]).includes(value);

export const modeRank = (mode: PermissionMode): number => PERMISSION_MODES.indexOf(mode);

/** The lower of two modes: a child, a delegated request or a ceiling only ever narrows. */
export const lowerMode = (a: PermissionMode, b: PermissionMode): PermissionMode => (modeRank(a) <= modeRank(b) ? a : b);

/** The most of these modes allows at or below a limit, or null when each is above it. */
export const highestWithin = (modes: readonly PermissionMode[], limit: PermissionMode): PermissionMode | null =>
  modes.filter((m) => modeRank(m) <= modeRank(limit)).reduce<PermissionMode | null>((best, m) => (best && modeRank(best) >= modeRank(m) ? best : m), null);
