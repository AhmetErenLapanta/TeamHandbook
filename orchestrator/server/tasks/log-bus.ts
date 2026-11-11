import { EventEmitter } from "node:events";

/*
 * A word, in this process, that a task's log or state was just written: a page following the task
 * here reads it at once instead of at its next look at the store. The store stays what every
 * orchestrator reads, so a page on another one still sees the write at its own next look.
 */

const bus = new EventEmitter();
bus.setMaxListeners(0);
const key = (tenant: string, taskId: string) => `${tenant}\0${taskId}`;

export function taskWritten(tenant: string, taskId: string): void {
  bus.emit(key(tenant, taskId));
}

/** Resolves on the task's next write here, or after `ms`, whichever comes first. */
export function nextTaskWrite(tenant: string, taskId: string, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bus.off(key(tenant, taskId), done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    bus.once(key(tenant, taskId), done);
  });
}
