import type { OrchestratorContext } from "../app.js";
import { secretsForTask } from "../task-secrets.js";
import { Redactor } from "./redact.js";
import { printable } from "./runner.js";

/**
 * The one mask for text a task gives rise to, wherever it is kept: its task's secrets by value
 * and every credential by its shape, line by line, then control characters made visible, as a
 * run on this orchestrator writes its own log. Text from a person's machine passes it before it
 * is stored, since the machine is the person's and is not trusted to have masked it.
 */
export async function taskMask(ctx: Pick<OrchestratorContext, "store" | "tenant" | "vault">, task: { repoId: string; team: string }): Promise<(text: string) => string> {
  const redactor = new Redactor((await secretsForTask(ctx, task.repoId, task.team)).map((secret) => secret.value));
  return (text) => text.split("\n").map((line) => printable(redactor.line(line))).join("\n");
}
