/**
 * The command a person runs to connect a machine, as Settings shows it, the CLI reads it and the
 * docs quote it: one text, so the screen, the command line and the docs cannot drift apart.
 */
export const RUNNER_CONNECT = "handbook-orchestrator runner connect";

/** The full command for one pairing: the address the machine keeps and the code it uses once. */
export const connectCommand = (address: string, code: string) => `${RUNNER_CONNECT} ${address} ${code}`;
