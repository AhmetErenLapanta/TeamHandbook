import type { Page } from "@playwright/test";

/** A changed file as a stand-in serves it: the list's fields, and the patch and note its own read answers. */
export interface StandInFile { path: string; status: "added" | "modified" | "deleted" | "renamed"; additions: number | null; deletions: number | null; binary?: boolean; test?: boolean; patch: string | null; truncated?: boolean; note?: string | null }

/** Answers a request's file list and each file's patch, the two reads its Changes fold makes. */
export async function standInChanges(page: Page, repoId: string, number: number, files: StandInFile[], omitted = 0): Promise<void> {
  const base = `/api/repos/${repoId}/requests/${number}/changes`;
  const listed = files.map((f) => ({ path: f.path, status: f.status, previousPath: null, additions: f.additions, deletions: f.deletions, binary: f.binary ?? false, test: f.test ?? false }));
  await page.route((url) => url.pathname === base, (route) => route.fulfill({ json: { changes: { base: "a1", head: "b2", omitted, files: listed } } }));
  await page.route((url) => url.pathname.startsWith(`${base}/`), (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname.slice(base.length + 1));
    const file = files.find((f) => f.path === path);
    if (!file) return route.fulfill({ status: 404, json: { error: "this request does not change that file" } });
    return route.fulfill({ json: { file: { ...listed.find((f) => f.path === path), patch: file.patch, truncated: file.truncated ?? false, note: file.note ?? null } } });
  });
}
