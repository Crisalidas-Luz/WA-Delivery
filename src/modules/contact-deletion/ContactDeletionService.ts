import type { CampaignService } from '../campaigns/CampaignService.js';
import type { CampaignRecipientSnapshot } from '../campaigns/campaignTypes.js';
import { normalizePhone } from '../contacts/phone.js';
import type { GoogleAuthService } from '../google-auth/GoogleAuthService.js';
import type { GoogleContactsRepository } from '../google-contacts/GoogleContactsRepository.js';
import type { SettingsService } from '../settings/SettingsService.js';
import type { WhatsAppProvider } from '../../providers/whatsapp/WhatsAppProvider.js';
import { GoogleContactNotFoundError } from '../../providers/google/GooglePeopleProvider.js';
import { ContactDeletionRepository } from './ContactDeletionRepository.js';
import {
  ContactDeletionValidationError,
  type ContactDeletionItem,
  type ContactDeletionJob,
} from './contactDeletionTypes.js';

export interface CreateContactDeletionJobInput {
  confirmed?: boolean;
  recipientIds?: number[];
  filterSnapshot?: Record<string, unknown>;
}

const TERMINAL_CAMPAIGN_STATES = new Set(['completed', 'cancelled', 'failed']);
const MAX_DELETION_ITEMS = 10_000;
const ALLOWED_REASONS = new Set<ContactDeletionItem['reasonCode']>([
  'missing_phone',
  'invalid_phone',
  'not_on_whatsapp',
]);

export class ContactDeletionService {
  private readonly activeJobs = new Set<number>();

  public constructor(
    private readonly repository: ContactDeletionRepository,
    private readonly campaigns: CampaignService,
    private readonly google: GoogleAuthService,
    private readonly googleContacts: GoogleContactsRepository,
    private readonly whatsapp: WhatsAppProvider,
    private readonly settings: SettingsService,
    private readonly wait: (milliseconds: number) => Promise<void> = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
  ) {}

  public find(id: number): ContactDeletionJob | undefined {
    return this.repository.find(id);
  }

  public findLatestForCampaign(campaignId: number): ContactDeletionJob | undefined {
    return this.repository.findLatestForCampaign(campaignId);
  }

  public recoverInterrupted(): number {
    return this.repository.recoverInterrupted();
  }

  public async createAndExecute(
    campaignId: number,
    input: CreateContactDeletionJobInput,
  ): Promise<ContactDeletionJob> {
    const job = this.createJob(campaignId, input);
    return this.execute(job.id);
  }

  public createAndStart(
    campaignId: number,
    input: CreateContactDeletionJobInput,
  ): ContactDeletionJob {
    const job = this.createJob(campaignId, input);
    return this.startInBackground(job.id, false);
  }

  private createJob(campaignId: number, input: CreateContactDeletionJobInput): ContactDeletionJob {
    if (input.confirmed !== true) {
      throw new ContactDeletionValidationError(
        'Confirme explicitamente que deseja excluir os contatos selecionados da conta Google.',
      );
    }
    const ids = [...new Set(input.recipientIds ?? [])];
    if (ids.length > MAX_DELETION_ITEMS) {
      throw new ContactDeletionValidationError(
        `Cada job de exclusão aceita no máximo ${MAX_DELETION_ITEMS.toLocaleString('pt-BR')} contatos.`,
      );
    }
    if (ids.length === 0 || ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
      throw new ContactDeletionValidationError('Selecione ao menos um destinatário válido.');
    }
    const campaign = this.campaigns.findById(campaignId);
    if (!campaign) throw new ContactDeletionValidationError('Campanha não encontrada.');
    if (!TERMINAL_CAMPAIGN_STATES.has(campaign.status)) {
      throw new ContactDeletionValidationError(
        'A exclusão só pode ser revisada depois que a campanha terminar ou for cancelada.',
      );
    }
    const recipients = this.campaigns.listRecipients(campaignId) ?? [];
    const byId = new Map(recipients.map((recipient) => [recipient.id, recipient]));
    const selected = ids.map((id) => byId.get(id));
    if (selected.some((recipient) => !recipient)) {
      throw new ContactDeletionValidationError(
        'A seleção contém um destinatário que não pertence à campanha.',
      );
    }
    const items = (selected as CampaignRecipientSnapshot[]).map((recipient) =>
      this.toDeletionItem(recipient),
    );
    if (new Set(items.map((item) => item.resourceName)).size !== items.length) {
      throw new ContactDeletionValidationError(
        'A seleção contém mais de um destinatário vinculado ao mesmo contato Google.',
      );
    }
    return this.repository.create(campaignId, input.filterSnapshot ?? {}, items);
  }

  public async retry(id: number): Promise<ContactDeletionJob | undefined> {
    const job = this.repository.find(id);
    if (!job) return undefined;
    if (job.status === 'running') {
      throw new ContactDeletionValidationError('Este job de exclusão já está em execução.');
    }
    if (this.repository.retryFailed(id) === 0) {
      throw new ContactDeletionValidationError(
        'Não existem exclusões com falha para tentar novamente.',
      );
    }
    return this.execute(id);
  }

  public retryAndStart(id: number): ContactDeletionJob | undefined {
    const job = this.repository.find(id);
    if (!job) return undefined;
    return this.startInBackground(id, true);
  }

  private startInBackground(id: number, resetFailed: boolean): ContactDeletionJob {
    if (this.activeJobs.has(id)) return this.repository.find(id) as ContactDeletionJob;
    const job = this.repository.find(id);
    if (!job) throw new ContactDeletionValidationError('Job de exclusão não encontrado.');
    if (job.status === 'running') {
      throw new ContactDeletionValidationError('Este job de exclusão já está em execução.');
    }
    if (resetFailed) this.repository.retryFailed(id);
    const current = this.repository.find(id) as ContactDeletionJob;
    if (!current.items.some((item) => item.status === 'pending')) {
      throw new ContactDeletionValidationError('Não existem exclusões pendentes para retomar.');
    }
    this.activeJobs.add(id);
    void this.execute(id)
      .catch(() => this.repository.failJob(id))
      .finally(() => this.activeJobs.delete(id));
    return this.repository.find(id) as ContactDeletionJob;
  }

  private toDeletionItem(recipient: CampaignRecipientSnapshot) {
    const reason = recipient.deletionReasonCode ?? recipient.eligibilityStatus;
    if (
      recipient.deletionRecommendation === 'not_recommended' ||
      !ALLOWED_REASONS.has(reason as ContactDeletionItem['reasonCode'])
    ) {
      throw new ContactDeletionValidationError(
        `O destinatário ${recipient.name} não possui evidência forte para exclusão.`,
      );
    }
    if (!recipient.googleContactId || !recipient.resourceName) {
      throw new ContactDeletionValidationError(
        `O destinatário ${recipient.name} não possui vínculo verificável com o Google Contacts.`,
      );
    }
    return {
      googleContactId: recipient.googleContactId,
      resourceName: recipient.resourceName,
      displayName: recipient.name,
      phone: recipient.phoneOriginal ?? recipient.phone ?? '',
      reasonCode: reason as ContactDeletionItem['reasonCode'],
      evidence: {
        version: 1,
        campaignRecipientId: recipient.id,
        eligibilityStatus: recipient.eligibilityStatus,
        resultCode: recipient.resultCode ?? null,
        resultReason: recipient.resultReason ?? null,
        attemptCount: recipient.attemptCount,
      },
    };
  }

  private async execute(id: number): Promise<ContactDeletionJob> {
    this.repository.start(id);
    let authorizationFailure = false;
    const job = this.repository.find(id) as ContactDeletionJob;
    for (const item of job.items.filter((candidate) => candidate.status === 'pending')) {
      this.repository.beginItem(item.id);
      try {
        const current = await this.google.getContact(item.resourceName);
        if (!current) {
          this.repository.finishItem(item.id, 'already_missing', true);
          continue;
        }
        await this.revalidate(
          item,
          current.phones.map((phone) => phone.value),
        );
        try {
          await this.deleteWithBackoff(item.resourceName);
          this.repository.finishItem(item.id, 'deleted', false);
        } catch (error) {
          if (!(error instanceof GoogleContactNotFoundError)) throw error;
          this.repository.finishItem(item.id, 'already_missing', true);
        }
      } catch (error) {
        const code = errorCode(error);
        this.repository.failItem(item.id, code, safeMessage(error));
        if (code === 'google_authorization') {
          authorizationFailure = true;
          this.repository.cancelPending(
            id,
            code,
            'Reconecte a conta Google antes de continuar as exclusões.',
          );
          break;
        }
      }
    }

    if (!authorizationFailure) await this.verifyAcceptedDeletions(id);
    this.repository.complete(id);
    return this.repository.find(id) as ContactDeletionJob;
  }

  private async revalidate(item: ContactDeletionItem, phones: string[]): Promise<void> {
    if (item.reasonCode === 'missing_phone') {
      if (phones.some((phone) => phone.trim())) throw evidenceChanged();
      return;
    }
    const normalized: string[] = [];
    for (const phone of phones) {
      try {
        normalized.push(normalizePhone(phone, this.settings.getAll()));
      } catch {
        // A própria evidência é que o telefone não pode ser normalizado.
      }
    }
    if (item.reasonCode === 'invalid_phone') {
      if (normalized.length > 0) throw evidenceChanged();
      return;
    }
    if (normalized.length !== 1) {
      throw new DeletionEvidenceError(
        'multiple_phones_require_review',
        'O contato possui zero ou vários telefones utilizáveis; revise-o manualmente no Google.',
      );
    }
    let registered: boolean;
    try {
      registered = await this.whatsapp.isRegisteredNumber(normalized[0] as string);
    } catch {
      throw new DeletionEvidenceError(
        'whatsapp_revalidation_failed',
        'Não foi possível confirmar novamente se o número está no WhatsApp.',
      );
    }
    if (registered) throw evidenceChanged();
  }

  private async deleteWithBackoff(resourceName: string): Promise<void> {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await this.google.deleteContact(resourceName);
        return;
      } catch (error) {
        const status = httpStatus(error);
        if ((status === 429 || (status !== undefined && status >= 500)) && attempt < 3) {
          await this.wait(250 * 2 ** (attempt - 1));
          continue;
        }
        throw error;
      }
    }
  }

  private async verifyAcceptedDeletions(id: number): Promise<void> {
    const accepted = (this.repository.find(id) as ContactDeletionJob).items.filter(
      (item) => item.status === 'deleted',
    );
    if (accepted.length === 0) return;
    try {
      await this.google.synchronize();
    } catch {
      return;
    }
    for (const item of accepted) {
      if (this.googleContacts.isRemoteDeleted(item.resourceName))
        this.repository.verifyItem(item.id);
    }
  }
}

class DeletionEvidenceError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function evidenceChanged(): DeletionEvidenceError {
  return new DeletionEvidenceError(
    'evidence_changed',
    'Os dados atuais do contato não confirmam mais o motivo escolhido para exclusão.',
  );
}

function httpStatus(error: unknown): number | undefined {
  const match = error instanceof Error ? /HTTP\s+(\d{3})/i.exec(error.message) : undefined;
  return match?.[1] ? Number(match[1]) : undefined;
}

function errorCode(error: unknown): string {
  if (error instanceof DeletionEvidenceError) return error.code;
  const status = httpStatus(error);
  if (status === 401 || status === 403) return 'google_authorization';
  if (status === 429) return 'google_rate_limit';
  if (status !== undefined && status >= 500) return 'google_unavailable';
  return 'google_deletion_failed';
}

function safeMessage(error: unknown): string {
  if (error instanceof DeletionEvidenceError) return error.message;
  const status = httpStatus(error);
  if (status === 401 || status === 403)
    return 'A autorização do Google expirou ou não permite excluir contatos.';
  if (status === 429)
    return 'O Google limitou temporariamente as exclusões. Tente novamente depois.';
  if (status !== undefined && status >= 500)
    return 'O Google está temporariamente indisponível. Tente novamente depois.';
  return 'Não foi possível excluir este contato do Google Contacts.';
}
