export type ContactDeletionItemStatus =
  'pending' | 'deleting' | 'deleted' | 'failed' | 'already_missing' | 'cancelled';

export interface ContactDeletionItem {
  id: number;
  jobId: number;
  googleContactId?: number;
  resourceName: string;
  displayName: string;
  phone: string;
  reasonCode: 'missing_phone' | 'invalid_phone' | 'not_on_whatsapp';
  evidence: Record<string, unknown>;
  status: ContactDeletionItemStatus;
  attemptCount: number;
  lastErrorCode?: string;
  lastErrorMessage?: string;
  requestedAt: string;
  deletedAt?: string;
  verifiedAt?: string;
  updatedAt: string;
}

export interface ContactDeletionJob {
  id: number;
  campaignId: number;
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed' | 'cancelled';
  requestedCount: number;
  filterSnapshot: Record<string, unknown>;
  confirmedAt: string;
  startedAt?: string;
  finishedAt?: string;
  createdAt: string;
  updatedAt: string;
  items: ContactDeletionItem[];
}

export class ContactDeletionValidationError extends Error {
  public readonly statusCode = 422;

  public constructor(message: string) {
    super(message);
    this.name = 'ContactDeletionValidationError';
  }
}
