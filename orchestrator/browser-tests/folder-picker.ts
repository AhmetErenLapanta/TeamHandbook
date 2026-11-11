import type { Locator } from "@playwright/test";

/** A browsing row by its folder's name alone, so "shop" is not also "shop-api". */
export function folderRow(picker: Locator, name: string): Locator {
  return picker.locator("button.folder-row").filter({ has: picker.page().locator(".folder-name", { hasText: new RegExp(`^${name}$`) }) });
}

/** The folder field that takes a name or a pasted path. */
export function folderField(picker: Locator): Locator {
  return picker.getByRole("textbox", { name: "Folder name or path" });
}

/** Opens a folder listed where the picker stands the way a person does: picks its row, then the foot's one Open. */
export async function openFolder(picker: Locator, name: string): Promise<void> {
  await folderRow(picker, name).focus();
  await picker.getByRole("button", { name: new RegExp(`^(Open|Add) ${name}$`) }).click();
}
