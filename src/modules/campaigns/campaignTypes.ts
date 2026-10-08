import type { ContactSelectionDefinition } from '../contact-selection/ContactSelectionService.js';

export interface CampaignComposerInput {
  name?: string;
  contactListId?: number;
  contactSelection?: ContactSelectionDefinition;
  messageTemplate: string;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  batchSize?: number;
  batchIntervalSeconds?: number;
  batchOrder?: 'name' | 'google' | 'random';
  batchOrderSeed?: string;
  mediaId?: number | null;
}

export interface CampaignSimulation {
  contactListId?: number;
  contactListName: string;
  selectionSource: 'local_list' | 'google';
  recipientCount: number;
  optedOutCount: number;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  durationMinSeconds: number;
  durationAverageSeconds: number;
  durationMaxSeconds: number;
  batchSize: number;
  batchCount: number;
  batchIntervalSeconds: number;
  batchOrder: 'name' | 'google' | 'random';
  samples: Array<{
    contactId: number;
    name: string;
    phone: string;
    message: string;
  }>;
}

export interface CampaignSummary {
  id: number;
  name: string;
  contactListId?: number;
  contactListName: string;
  recipientCount: number;
  messageTemplate: string;
  delayMinSeconds: number;
  delayMaxSeconds: number;
  selectionSource: 'local_list' | 'google';
  contactSelection?: ContactSelectionDefinition;
  selectionSummary?: Record<string, number>;
  selectionResolvedIds?: number[];
  batchSize: number;
  batchIntervalSeconds: number;
  batchOrder: 'name' | 'google' | 'random';
  batchOrderSeed?: string;
  currentBatchNumber: number;
  nextBatchAt?: string;
  status: 'draft' | 'ready' | 'running' | 'paused' | 'completed' | 'cancelled' | 'failed';
  createdAt: string;
  updatedAt: string;
  preparedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  sourceCampaignId?: number;
  media?: {
    id: number;
    originalName: string;
    mimetype: string;
    kind: 'image' | 'video';
    sizeBytes: number;
  };
}

export interface CampaignRecipientSnapshot {
  id: number;
  campaignId: number;
  sourceContactId?: number;
  googleContactId?: number;
  resourceName?: string;
  name: string;
  phone?: string;
  phoneOriginal?: string;
  phoneLabel?: string;
  renderedMessage: string;
  batchNumber: number;
  positionInBatch: number;
  eligibilityStatus:
    | 'eligible'
    | 'missing_phone'
    | 'invalid_phone'
    | 'duplicate_phone'
    | 'opted_out'
    | 'not_on_whatsapp'
    | 'stale_google_contact'
    | 'unknown';
  resultCode?: string;
  resultReason?: string;
  deletionRecommendation: 'recommended' | 'review' | 'not_recommended';
  deletionReasonCode?: string;
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'skipped';
  attemptCount: number;
  lastError?: string;
  sentAt?: string;
  updatedAt?: string;
}

export class CampaignValidationError extends Error {
  public constructor(public readonly issues: Array<{ path: string; message: string }>) {
    super('Os dados da campanha são inválidos.');
    this.name = 'CampaignValidationError';
  }
}
