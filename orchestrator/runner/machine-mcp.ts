/**
 * A project's MCP server as a lease names it for a machine: no value of the organization's, only
 * templates whose `${NAME}` the person's own environment fills. A plain part is kept as written.
 */
export type MachineMcpServer =
  | { type: "stdio"; command: string; args: string[]; env: Record<string, string> }
  | { type: "http" | "sse"; url: string; headers: Record<string, string> };

const REFERENCE = /\$\{([^}]*)\}/g;
const NAME = /^[A-Z_][A-Z0-9_]*$/;

/**
 * The servers with every `${NAME}` filled from this machine's environment, and the values filled,
 * for the masker. A server whose template names a variable that is not set here, or not as a
 * variable's name, is left out, said by its name and the variable's, never by a value. A server
 * filled says which of the person's variables it takes, by name, since the server is the team's
 * choice and the value goes to it.
 */
export function machineMcpServers(servers: Record<string, MachineMcpServer>, env: Record<string, string | undefined>): { servers: Record<string, Record<string, unknown>>; values: string[]; notes: string[] } {
  const filled: Record<string, Record<string, unknown>> = {};
  const values: string[] = [];
  const notes: string[] = [];
  for (const [name, server] of Object.entries(servers)) {
    const templates = server.type === "stdio" ? server.env : server.headers;
    let missing: string | null = null;
    const taken = new Set<string>();
    const fill = (template: string) =>
      template.replace(REFERENCE, (_, variable: string) => {
        const value = NAME.test(variable) ? env[variable] : undefined;
        if (!value) missing ??= NAME.test(variable) ? `${variable} is not set on this machine` : "one of its values names no variable";
        else {
          values.push(value);
          taken.add(variable);
        }
        return value ?? "";
      });
    const entries = Object.fromEntries(Object.entries(templates).map(([key, template]) => [key, fill(template)]));
    if (missing) {
      notes.push(`MCP server ${name} left out: ${missing}.`);
      continue;
    }
    if (taken.size) notes.push(`MCP server ${name} takes ${[...taken].join(", ")} from your environment.`);
    filled[name] = server.type === "stdio" ? { type: "stdio", command: server.command, args: server.args, env: entries } : { type: server.type, url: server.url, headers: entries };
  }
  return { servers: filled, values, notes };
}
