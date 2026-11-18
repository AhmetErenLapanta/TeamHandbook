/** Fired to put the cursor in the find row of the task page on screen, opening the log it searches when it is folded. */
export const FIND_IN_TASK = "orchestrator:find-in-task";

/** Fired with a log line's number to take the task page to it, opening the log when it is folded. */
export const SHOW_LOG_LINE = "orchestrator:show-log-line";

export function showLogLine(seq: number): void {
  window.dispatchEvent(new CustomEvent(SHOW_LOG_LINE, { detail: seq }));
}
