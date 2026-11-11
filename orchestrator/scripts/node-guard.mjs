// Node on a release older than the orchestrator's refuses with its own internal stack trace (an
// unknown built-in module, a missing export), which tells a person nothing. The package's bin and
// `npm start` ask this first, written for any Node that can run a module: no built-in newer than
// Node 18 is imported here.

/** What to tell a person whose Node is older than `range` (">=22.16"), or null when it is new enough. */
export function nodeTooOld(range, version = process.versions.node) {
  const [wantMajor, wantMinor = 0] = range.replace(/^>=/, "").split(".").map(Number);
  const [major, minor] = version.split(".").map(Number);
  if (major > wantMajor || (major === wantMajor && minor >= wantMinor)) return null;
  return `handbook-orchestrator needs Node ${wantMajor}.${wantMinor} or newer; this is Node ${version}. Install a newer Node, or take the install.sh install from the README: its executable carries its own.`;
}
