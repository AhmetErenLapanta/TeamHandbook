/** A file a person attached to a task: its bytes sit in the data directory, never in a repository or a task's checkout. */
export interface AttachmentRecord {
  tenant: string;
  id: string;
  taskId: string;
  /** The name as given, cleaned of paths and control characters. */
  name: string;
  mime: string;
  size: number;
  sha256: string;
  createdBy: string;
  createdAt: string;
}

export interface AttachmentLimits {
  perTask: number;
  tenantBytes: number;
}

export interface AttachmentStore {
  /** Keeps an attachment while the task holds fewer than `perTask` and the organization's together stay within `tenantBytes`, counted in the same transaction. */
  insertAttachment(attachment: AttachmentRecord, limits: AttachmentLimits): Promise<"kept" | "task-full" | "tenant-full">;
  getAttachment(tenant: string, id: string): Promise<AttachmentRecord | null>;
  taskAttachments(tenant: string, taskId: string): Promise<AttachmentRecord[]>;
  deleteAttachment(tenant: string, id: string): Promise<boolean>;
  /** The organization's attachments made before `before`, for the retention to delete with their files. */
  attachmentsBefore(tenant: string, before: string): Promise<AttachmentRecord[]>;
}
