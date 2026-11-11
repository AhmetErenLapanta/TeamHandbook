import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { cpus, loadavg } from "node:os";
import { join } from "node:path";

/** How many of its person's tasks a machine runs at once unless told otherwise, and the most it takes. */
export const DEFAULT_SLOTS = 2;
export const MAX_SLOTS = 3;
/** Past this much load per core, or on a battery below this, a machine takes one task at a time. */
export const BUSY_LOAD_PER_CORE = 0.8;
export const LOW_BATTERY_PERCENT = 30;

export interface MachineLoad {
  /** The last minute's load average over the machine's cores. */
  perCore: number;
  /** Null on a machine with no battery, or one whose battery could not be read. */
  battery: { charging: boolean; percent: number } | null;
}

/**
 * How many tasks the machine takes now: the person's choice within 1 and MAX_SLOTS, and one while
 * the machine is busy or on a low battery. It only holds back new tasks; one already running goes on.
 */
export function slotsFor(wanted: number, load: MachineLoad): number {
  const chosen = Math.min(MAX_SLOTS, Math.max(1, Math.floor(wanted) || 1));
  if (load.perCore >= BUSY_LOAD_PER_CORE) return 1;
  if (load.battery && !load.battery.charging && load.battery.percent < LOW_BATTERY_PERCENT) return 1;
  return chosen;
}

/** macOS: `pmset -g batt` says "NN%; discharging" for a battery and names no percent on a machine with none. */
function macBattery(): MachineLoad["battery"] {
  const done = spawnSync("pmset", ["-g", "batt"], { encoding: "utf8", timeout: 2_000 });
  const found = /(\d{1,3})%;\s*([a-z ]+);/i.exec(done.stdout ?? "");
  return found ? { percent: Number(found[1]), charging: !/discharging/i.test(found[2]!) } : null;
}

/** Linux: the first battery under /sys/class/power_supply, its capacity and status files. */
function linuxBattery(): MachineLoad["battery"] {
  const root = "/sys/class/power_supply";
  try {
    const battery = readdirSync(root).find((name) => name.startsWith("BAT"));
    if (!battery) return null;
    const percent = Number(readFileSync(join(root, battery, "capacity"), "utf8").trim());
    const status = readFileSync(join(root, battery, "status"), "utf8").trim();
    return Number.isFinite(percent) ? { percent, charging: status !== "Discharging" } : null;
  } catch {
    return null;
  }
}

/** This machine's load now; a battery that cannot be read counts as none, so it never holds tasks back on its own. */
export function machineLoad(platform: NodeJS.Platform = process.platform): MachineLoad {
  return { perCore: loadavg()[0]! / Math.max(1, cpus().length), battery: platform === "darwin" ? macBattery() : platform === "linux" ? linuxBattery() : null };
}
