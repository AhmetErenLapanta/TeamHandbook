/** What a tool's own failure means for the person and what they do next, for the shapes tasks meet; one not known here is kept as it reads. */
const PLAIN_FAILURES: [RegExp, string][] = [
  [/could not read Username|Authentication failed|terminal prompts disabled|HTTP Basic: Access denied/i, "The forge asked for a sign-in this orchestrator does not have. Connect the repository's forge under Integrations, then start the task again."],
  [/Permission denied \(publickey\)|Host key verification failed/i, "The forge refused this machine's SSH key. Add the key to your forge account, or connect the repository over HTTPS, then start the task again."],
  [/Repository not found|repository '.*' not found|does not appear to be a git repository/i, "The repository was not found at its address. Check its address under Projects, then start the task again."],
  [/non-fast-forward|\[rejected\]|fetch first|stale info/i, "The branch moved on the forge while the task ran. Start the task again to work from the branch as it is now."],
  [/Could not resolve host|ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNRESET|EAI_AGAIN|Network is unreachable/i, "A service the task needed could not be reached. Check this machine's network connection, then start the task again."],
  [/spawn (\S+) ENOENT/i, "A program the task runs is not installed on this machine, or not on its PATH. Install it, then start the task again."],
  [/ENOSPC|No space left on device/i, "This machine's disk is full. Free some space, then start the task again."],
  [/EACCES|EPERM|Operation not permitted/i, "A file or folder the task needed could not be opened: this machine refused the permission. Check that the orchestrator can read the project's folder, then start the task again."],
];

/** A failure as the task's reason reads it: in a person's words when its shape is known, otherwise as the tool said it, masked. */
export function plainFailure(message: string): string {
  return PLAIN_FAILURES.find(([shape]) => shape.test(message))?.[1] ?? message;
}
