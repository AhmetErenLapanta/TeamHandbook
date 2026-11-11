import { rm } from "node:fs/promises";
import type { OrchestratorContext } from "./app.js";
import { effectWorker, EffectRefused } from "./effects.js";
import type { EffectHandler, EffectInput, EffectRecord, EffectReplay } from "./effects.js";
import type { Store } from "./store.js";
import { dockerEnv, runProcess, taskPaths } from "./tasks/isolation.js";

export interface EffectDefinition {
  replay: EffectReplay;
  run: (ctx: OrchestratorContext, effect: EffectRecord) => Promise<string | null>;
}

/**
 * What a finished task leaves on this machine: its checkout, its git directory and, when it ran in
 * one, its container. Each is removed until it is gone, so a removal that failed is tried again by
 * the worker rather than left for the next start's sweep, which stays the last resort. The payload
 * says only whether there was a container; its name comes from the task, never from the payload.
 */
const taskCleanup: EffectDefinition = {
  replay: "replay-safe",
  async run(ctx, effect) {
    const paths = taskPaths(ctx.dataDir, ctx.tenant, effect.taskId);
    await Promise.all([rm(paths.root, { recursive: true, force: true }), rm(paths.git, { recursive: true, force: true })]);
    if (effect.payload.container !== true) return null;
    const name = `teamhandbook-task-${ctx.tenant}-${effect.taskId}`;
    const said: string[] = [];
    const removal = await runProcess(
      { program: "docker", args: ["rm", "-f", name], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...dockerEnv(process.env) }, cwd: ctx.dataDir },
      { timeoutMs: 30_000, signal: new AbortController().signal, onLine: (_stream, line) => void said.push(line) },
    );
    // A container already gone is what the removal wanted.
    if (removal.code !== 0 && !said.some((line) => /no such container/i.test(line))) throw new Error(`docker rm -f ${name} failed (exit code ${removal.code ?? "none"}): ${said.find((l) => l.trim()) ?? ""}`);
    return null;
  },
};

/**
 * Every kind of task effect, in one place: what a restart does to it and what carries it out.
 * An owner adds a kind here with its handler; a kind queued that has no entry fails at once.
 */
export const EFFECTS = { "task.cleanup": taskCleanup } satisfies Record<string, EffectDefinition>;

export type EffectKind = keyof typeof EFFECTS;

/** An effect to queue with a command, its restart class taken from its definition rather than written again by the caller. */
export function effectOf(kind: EffectKind, payload: Record<string, unknown>): EffectInput {
  return { kind, payload, replay: (EFFECTS as Record<string, EffectDefinition>)[kind]!.replay };
}

/**
 * Carries out the effects of the organizations this process serves: a worker over every kind
 * defined above, started only once a kind has a handler. Returns what stops the worker.
 */
export function startEffects(store: Store, served: () => readonly OrchestratorContext[], by: string, definitions: Readonly<Record<string, EffectDefinition>> = EFFECTS): () => Promise<void> {
  const kinds = Object.keys(definitions);
  if (!kinds.length) return async () => undefined;
  const handlers: Record<string, EffectHandler> = Object.fromEntries(
    kinds.map((kind) => [
      kind,
      async (effect: EffectRecord) => {
        const ctx = served().find((c) => c.tenant === effect.tenant);
        if (!ctx) throw new EffectRefused(`this process does not serve ${effect.tenant}`);
        return definitions[kind]!.run(ctx, effect);
      },
    ]),
  );
  const worker = effectWorker({ store, handlers, by, tenants: () => served().map((c) => c.tenant) });
  worker.start();
  return () => worker.stop();
}
