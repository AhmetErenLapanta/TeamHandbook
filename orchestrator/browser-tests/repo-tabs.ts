import type { Page } from "@playwright/test";

/** Opens one section of a repository's page from its tabs, as a person moves between them. */
export function openTab(page: Page, repo: string, name: "Overview" | "Skills" | "MCP servers" | "Commands" | "Requests" | "Settings"): Promise<void> {
  return page.getByRole("navigation", { name: `${repo} sections` }).getByRole("link", { name, exact: true }).click();
}
