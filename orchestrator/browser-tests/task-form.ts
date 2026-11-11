import type { Locator, Page } from "@playwright/test";

/** The one field the task form starts with: an issue link, or the work in words (its first line the title). */
export async function work(form: Locator, text: string): Promise<void> {
  await form.getByLabel("What needs doing?").fill(text);
}

/** Picks an option in one of the orchestrator's dropdowns, by the field's label. */
export async function choose(scope: Locator, label: string, option: string | RegExp): Promise<void> {
  await scope.getByRole("combobox", { name: label, exact: true }).click();
  await scope.page().getByRole("option", { name: option, exact: typeof option === "string" }).click();
}

/** The options a dropdown offers, read by opening it and closed again. */
export async function optionsOf(scope: Locator, label: string): Promise<string[]> {
  const field = scope.getByRole("combobox", { name: label, exact: true });
  await field.click();
  const names = await scope.page().getByRole("option").allInnerTexts();
  await field.press("Escape");
  return names.map((n) => n.replace(/\s+/g, " ").trim());
}

/** Opens the task form's folded part, where the title, the notes and the agent's own choices are. */
export async function moreOptions(form: Locator): Promise<void> {
  const more = form.locator("details.more");
  if ((await more.getAttribute("open")) === null) await more.locator("summary").click();
}

/** The agent sits beside the project, outside the folded part. */
export async function chooseAgent(form: Locator, agent: string | RegExp = /^Demo agent/): Promise<void> {
  await choose(form, "Agent", agent);
}

/**
 * The task form as a person reaches it: open already when a link fills it, words wait in it or no
 * task has run, and otherwise behind the Tasks page's New task.
 */
export async function newTaskForm(page: Page): Promise<Locator> {
  const form = page.getByRole("form", { name: "New task" });
  await form.waitFor();
  return form;
}
