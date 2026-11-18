/** The types a task takes and how much of each, as the orchestrator holds them; a file it would refuse is said before it is sent. */
export const ATTACHMENT_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf", "text/plain", "application/json"] as const;
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_TYPES, ".txt", ".md", ".json", ".log"].join(",");
export const MOST_BYTES = 10 * 1024 * 1024;
export const MOST_FILES = 20;

/** One file the person chose, with where it stands: waiting for its task, sending, sent (with its id) or failed. */
export interface ChosenFile {
  key: string;
  file: File;
  state: "waiting" | "sending" | "sent" | "failed";
  id?: string;
  error?: string;
}

/** What a file's type is taken to be: the browser's word, else what its extension says for plain text. */
export function typeOf(file: Pick<File, "name" | "type">): string {
  // A browser names a Markdown note text/markdown and a log text/x-log: to the agent both are plain text.
  if (file.type.startsWith("text/") && file.type !== "text/html") return "text/plain";
  if (file.type) return file.type;
  return /\.(txt|md|log)$/i.test(file.name) ? "text/plain" : /\.json$/i.test(file.name) ? "application/json" : "";
}

/** Why a file is not taken, in one sentence, or null; `held` is how many files the task has or is about to have. */
export function fileProblem(file: Pick<File, "name" | "type" | "size">, held: number): string | null {
  if (held >= MOST_FILES) return `A task takes up to ${MOST_FILES} files.`;
  if (!(ATTACHMENT_TYPES as readonly string[]).includes(typeOf(file))) return `${file.name} is not a file the agent reads: PNG, JPEG, GIF, WebP, PDF, text or JSON.`;
  if (file.size > MOST_BYTES) return `${file.name} is over 10 MB.`;
  if (file.size === 0) return `${file.name} is empty.`;
  return null;
}

/** The files a drop or a paste carries, in order; a pasted screenshot has no name, so it is given one. */
export function filesOf(items: DataTransfer | null): File[] {
  if (!items) return [];
  return [...items.files].map((f, i) => (f.name ? f : new File([f], `pasted-${i + 1}.${(f.type.split("/")[1] ?? "png").replace("jpeg", "jpg")}`, { type: f.type })));
}
