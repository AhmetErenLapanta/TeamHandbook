import { readPref, writePref } from "../prefs";

const key = (kind: "source" | "board" | "sprint", within = "") => `orchestrator.work.${kind}${within ? `.${within}` : ""}`;

export const rememberedSource = () => readPref(key("source"));
export const rememberedBoard = (source: string) => readPref(key("board", source));
export const rememberedSprint = (board: string) => readPref(key("sprint", board));

export const rememberSource = (id: string) => writePref(key("source"), id);
export const rememberBoard = (source: string, id: string | null) => id && writePref(key("board", source), id);
export const rememberSprint = (board: string, id: string | null) => id && writePref(key("sprint", board), id);

/** The address wins; else the one picked last if it is still there; else none, and the caller falls to its default. */
export function chosen<T extends { id: string }>(list: T[], inAddress: string | null, remembered: string | null): T | undefined {
  return list.find((x) => x.id === inAddress) ?? list.find((x) => x.id === remembered);
}
