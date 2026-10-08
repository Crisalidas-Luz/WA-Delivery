import { randomUUID } from 'node:crypto';
import type { ContactService } from '../contacts/ContactService.js';
import type {
  ContactSelectionService,
  ResolvedContactSelectionWithContacts,
} from '../contact-selection/ContactSelectionService.js';
import type { ContactSearchItem } from '../contact-selection/ContactSelectionRepository.js';
import type { MediaService } from '../media/MediaService.js';
import { CampaignRepository } from './CampaignRepository.js';
import { deletionRecommendationFor, type RecipientEligibility } from './campaignResultTypes.js';
import {
  CampaignValidationError,
  type CampaignComposerInput,
  type CampaignManifest,
  type CampaignRecipientSnapshot,
  type CampaignSimulation,
  type CampaignSummary,
} from './campaignTypes.js';

const MAX_MESSAGE_LENGTH = 4_096;
const MAX_DELAY_SECONDS = 3_600;

export class CampaignService {
  public constructor(
    private readonly repository: CampaignRepository,
    private readonly contacts: ContactService,
    private readonly media: MediaService,
    private readonly contactSelection?: ContactSelectionService,
  ) {}

  public simulate(input: CampaignComposerInput): CampaignSimulation {
    const validated = this.validate(input, false);
    if (validated.contactSelection) return this.simulateGoogle(validated);
    const list = this.contacts.findById(validated.contactListId!);
    if (!list) {
      throw new CampaignValidationError([
        { path: 'contactListId', message: 'A lista de contatos não existe.' },
      ]);
    }
    if (list.contacts.length === 0) {
      throw new CampaignValidationError([
        { path: 'contactListId', message: 'A lista selecionada está vazia.' },
      ]);
    }

    // Contatos com opt-out são bloqueados: não entram na simulação nem no snapshot.
    const eligible = list.contacts.filter((contact) => !contact.optedOut);
    const optedOutCount = list.contacts.length - eligible.length;
    if (eligible.length === 0) {
      throw new CampaignValidationError([
        {
          path: 'contactListId',
          message: 'Todos os contatos da lista estão marcados como opt-out.',
        },
      ]);
    }

    // Variáveis disponíveis: `nome` + colunas extras presentes na lista.
    const availableVariables = new Set<string>(['nome']);
    for (const contact of list.contacts) {
      for (const key of Object.keys(contact.data ?? {})) availableVariables.add(key);
    }
    const unknownVariables = [...validated.messageTemplate.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
      .map((match) => match[1]?.trim().toLowerCase())
      .filter((variable): variable is string => Boolean(variable))
      .filter((variable) => !availableVariables.has(variable));
    if (unknownVariables.length > 0) {
      throw new CampaignValidationError([
        {
          path: 'messageTemplate',
          message: `Variáveis não reconhecidas para esta lista: ${[...new Set(unknownVariables)].join(', ')}.`,
        },
      ]);
    }

    const batchCount = Math.ceil(eligible.length / validated.batchSize!);
    const intervals = Math.max(0, eligible.length - batchCount);
    const batchWait = Math.max(0, batchCount - 1) * validated.batchIntervalSeconds!;
    return {
      contactListId: list.id,
      contactListName: list.name,
      selectionSource: 'local_list',
      recipientCount: eligible.length,
      optedOutCount,
      delayMinSeconds: validated.delayMinSeconds,
      delayMaxSeconds: validated.delayMaxSeconds,
      durationMinSeconds: intervals * validated.delayMinSeconds + batchWait,
      durationAverageSeconds: Math.round(
        intervals * ((validated.delayMinSeconds + validated.delayMaxSeconds) / 2) + batchWait,
      ),
      durationMaxSeconds: intervals * validated.delayMaxSeconds + batchWait,
      batchSize: validated.batchSize!,
      batchCount,
      batchIntervalSeconds: validated.batchIntervalSeconds!,
      batchOrder: validated.batchOrder!,
      samples: eligible.slice(0, 3).map((contact) => ({
        contactId: contact.id,
        name: contact.name,
        phone: contact.phone,
        message: renderMessage(validated.messageTemplate, contact.name, contact.data),
      })),
    };
  }

  public createDraft(input: CampaignComposerInput): CampaignSummary {
    const validated = this.validate(input, true);
    this.simulate(validated);
    const campaign = this.repository.createDraft(
      validated as CampaignComposerInput & { name: string },
    );
    if (validated.contactSelection) {
      const resolved = this.requireGoogleSelection(validated.contactSelection);
      this.repository.saveSelectionResolution(campaign.id, resolved.summary, resolved.contactIds);
      return this.repository.findById(campaign.id)!;
    }
    return campaign;
  }

  public list(): CampaignSummary[] {
    return this.repository.list();
  }

  public findById(id: number): CampaignSummary | undefined {
    return this.repository.findById(id);
  }

  public async updateDraft(
    id: number,
    input: CampaignComposerInput,
  ): Promise<CampaignSummary | undefined> {
    const existing = this.repository.findById(id);
    if (!existing || existing.status !== 'draft') return undefined;
    const validated = this.validate(input, true, existing.media?.id);
    const { mediaId: _mediaId, ...simulationInput } = validated;
    if (existing.sourceCampaignId && existing.selectionSource === 'local_list') {
      this.requireFollowUpCandidates(existing.sourceCampaignId);
    } else {
      this.simulate(simulationInput);
    }
    const updated = this.repository.updateDraft(
      id,
      validated as CampaignComposerInput & { name: string },
    );
    if (!updated) return undefined;
    if (updated.removedMediaStorageName) {
      await this.media.removeFile(updated.removedMediaStorageName);
    }
    if (validated.contactSelection) {
      const resolved = this.requireGoogleSelection(validated.contactSelection);
      this.repository.saveSelectionResolution(
        updated.campaign.id,
        resolved.summary,
        resolved.contactIds,
      );
      return this.repository.findById(updated.campaign.id);
    }
    return updated.campaign;
  }

  public async deleteCampaign(id: number): Promise<boolean> {
    const deleted = this.repository.deleteCampaign(id);
    if (!deleted) return false;
    if (deleted.mediaStorageName) await this.media.removeFile(deleted.mediaStorageName);
    return true;
  }

  /**
   * Limpeza explícita por retenção: remove campanhas finalizadas há mais de
   * `retentionDays` dias, junto com destinatários, tentativas e mídias. Retorna
   * quantas foram removidas. `retentionDays <= 0` desativa a limpeza (no-op).
   */
  public async cleanupOldCampaigns(retentionDays: number): Promise<number> {
    if (!Number.isFinite(retentionDays) || retentionDays <= 0) return 0;
    const { deletedCount, mediaStorageNames } = this.repository.deleteFinishedBefore(retentionDays);
    for (const storageName of mediaStorageNames) {
      await this.media.removeFile(storageName);
    }
    return deletedCount;
  }

  /**
   * Cria uma nova campanha (rascunho) a partir de uma campanha terminal,
   * contendo apenas os destinatários pendentes (que não foram enviados com
   * sucesso). A campanha de origem é preservada como histórico e a nova fica
   * vinculada a ela.
   */
  public createFollowUp(id: number): CampaignSummary {
    const source = this.repository.findById(id);
    if (!source) {
      throw new CampaignValidationError([{ path: 'id', message: 'Campanha não encontrada.' }]);
    }
    const terminal =
      source.status === 'completed' || source.status === 'cancelled' || source.status === 'failed';
    if (!terminal) {
      throw new CampaignValidationError([
        {
          path: 'status',
          message:
            'Só é possível reenviar a partir de uma campanha finalizada, cancelada ou com falha.',
        },
      ]);
    }
    const pending = this.requireFollowUpCandidates(id);
    if (pending.length === 0) {
      throw new CampaignValidationError([
        {
          path: 'recipients',
          message: 'Não há destinatários pendentes elegíveis para reenviar nesta campanha.',
        },
      ]);
    }
    let draftSource = source;
    if (source.selectionSource === 'google') {
      const googleIds = pending
        .map((recipient) => recipient.googleContactId)
        .filter((contactId): contactId is number => contactId !== undefined);
      if (googleIds.length === 0 || !source.contactSelection) {
        throw new CampaignValidationError([
          { path: 'recipients', message: 'Os pendentes não possuem vínculo Google válido.' },
        ]);
      }
      const selection = {
        ...source.contactSelection,
        selectAllMatching: false,
        includedIds: googleIds,
        excludedIds: [],
      };
      const resolved = this.requireGoogleSelection(selection);
      draftSource = {
        ...source,
        contactSelection: resolved.definition,
        selectionSummary: resolved.summary,
        selectionResolvedIds: resolved.contactIds,
      };
    }
    return this.repository.createFollowUpDraft(draftSource, pending.length);
  }

  public prepareDraft(id: number, confirmed: boolean): CampaignSummary | undefined {
    if (confirmed !== true) {
      throw new CampaignValidationError([
        { path: 'confirmed', message: 'Confirme que revisou os destinatários e o conteúdo.' },
      ]);
    }
    const campaign = this.repository.findById(id);
    if (!campaign || campaign.status !== 'draft') return undefined;
    if (campaign.sourceCampaignId && campaign.selectionSource === 'local_list') {
      return this.prepareLocalFollowUp(campaign);
    }
    if (campaign.selectionSource === 'google') return this.prepareGoogleDraft(campaign);
    const list = this.contacts.findById(campaign.contactListId!);
    if (!list || list.contacts.length === 0) {
      throw new CampaignValidationError([
        { path: 'contactListId', message: 'A lista selecionada não existe ou está vazia.' },
      ]);
    }
    // Bloqueia contatos com opt-out: não são incluídos no snapshot imutável.
    const eligible = list.contacts.filter((contact) => !contact.optedOut);
    if (eligible.length === 0) {
      throw new CampaignValidationError([
        {
          path: 'contactListId',
          message: 'Todos os contatos da lista estão marcados como opt-out.',
        },
      ]);
    }
    return this.repository.prepareDraft(
      id,
      eligible.map((contact, index) => ({
        sourceContactId: contact.id,
        name: contact.name,
        phone: contact.phone,
        renderedMessage: renderMessage(campaign.messageTemplate, contact.name, contact.data),
        batchNumber: Math.floor(index / campaign.batchSize) + 1,
        positionInBatch: (index % campaign.batchSize) + 1,
      })),
    );
  }

  private requireFollowUpCandidates(
    sourceId: number,
  ): Array<CampaignRecipientSnapshot & { phone: string }> {
    const optedOut = this.contacts.optedOutPhones();
    const candidates = this.repository
      .listRecipients(sourceId)
      .filter(
        (recipient): recipient is CampaignRecipientSnapshot & { phone: string } =>
          recipient.status !== 'sent' &&
          recipient.phone !== undefined &&
          recipient.eligibilityStatus === 'eligible' &&
          !optedOut.has(recipient.phone) &&
          (['permanent_failure', 'transient_failure_exhausted', 'skipped_cancelled'].includes(
            recipient.resultCode ?? '',
          ) ||
            (!recipient.resultCode && ['failed', 'skipped'].includes(recipient.status))),
      );
    if (candidates.length === 0) {
      throw new CampaignValidationError([
        {
          path: 'recipients',
          message: 'Não há destinatários pendentes elegíveis para reenviar nesta campanha.',
        },
      ]);
    }
    return candidates;
  }

  private prepareLocalFollowUp(campaign: CampaignSummary): CampaignSummary | undefined {
    const source = this.repository.findById(campaign.sourceCampaignId!);
    if (!source) {
      throw new CampaignValidationError([
        { path: 'sourceCampaignId', message: 'A campanha de origem não está mais disponível.' },
      ]);
    }
    const candidates = this.requireFollowUpCandidates(source.id);
    return this.repository.prepareDraft(
      campaign.id,
      candidates.map((recipient, index) => ({
        ...(recipient.sourceContactId === undefined
          ? {}
          : { sourceContactId: recipient.sourceContactId }),
        name: recipient.name,
        phone: recipient.phone,
        phoneOriginal: recipient.phoneOriginal ?? recipient.phone,
        renderedMessage:
          campaign.messageTemplate === source.messageTemplate
            ? recipient.renderedMessage
            : renderMessage(campaign.messageTemplate, recipient.name),
        batchNumber: Math.floor(index / campaign.batchSize) + 1,
        positionInBatch: (index % campaign.batchSize) + 1,
      })),
    );
  }

  public listRecipients(id: number): CampaignRecipientSnapshot[] | undefined {
    if (!this.repository.findById(id)) return undefined;
    return this.repository.listRecipients(id);
  }

  public manifest(id: number): CampaignManifest | undefined {
    const items = this.listRecipients(id);
    if (items === undefined) return undefined;
    return {
      campaignId: id,
      generatedAt: new Date().toISOString(),
      summary: {
        selected: items.length,
        eligible: items.filter((item) => item.eligibilityStatus === 'eligible').length,
        ineligible: items.filter((item) => item.eligibilityStatus !== 'eligible').length,
        accepted: items.filter((item) => item.resultCode === 'accepted').length,
        permanentFailures: items.filter((item) => item.resultCode === 'permanent_failure').length,
        transientFailuresExhausted: items.filter(
          (item) => item.resultCode === 'transient_failure_exhausted',
        ).length,
        notOnWhatsApp: items.filter((item) => item.eligibilityStatus === 'not_on_whatsapp').length,
        missingPhone: items.filter((item) => item.eligibilityStatus === 'missing_phone').length,
        invalidPhone: items.filter((item) => item.eligibilityStatus === 'invalid_phone').length,
        duplicatePhone: items.filter((item) => item.eligibilityStatus === 'duplicate_phone').length,
        optedOut: items.filter((item) => item.eligibilityStatus === 'opted_out').length,
        totalAttempts: items.reduce((total, item) => total + item.attemptCount, 0),
        recommendedForDeletion: items.filter(
          (item) => item.deletionRecommendation === 'recommended',
        ).length,
        recommendedForReview: items.filter((item) => item.deletionRecommendation === 'review')
          .length,
      },
      items,
    };
  }

  /**
   * Gera um relatório CSV dos destinatários da campanha. Quando `onlyFailures`
   * é verdadeiro, inclui apenas os destinatários com falha ou ignorados
   * (lista acionável de reenvio). Retorna undefined se a campanha não existir.
   */
  public exportRecipientsCsv(id: number, onlyFailures = false): string | undefined {
    const recipients = this.listRecipients(id);
    if (recipients === undefined) return undefined;
    const rows = onlyFailures
      ? recipients.filter((r) => r.status === 'failed' || r.status === 'skipped')
      : recipients;
    const header = [
      'nome',
      'telefone',
      'lote',
      'elegibilidade',
      'resultado',
      'motivo',
      'status',
      'tentativas',
      'envio_aceito_em',
      'recomendacao_exclusao',
      'ultimo_erro',
    ];
    const lines = [header.map(csvCell).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.name,
          r.phone ?? r.phoneOriginal ?? '',
          String(r.batchNumber),
          r.eligibilityStatus,
          r.resultCode ?? '',
          r.resultReason ?? '',
          r.status,
          String(r.attemptCount),
          r.sentAt ?? '',
          r.deletionRecommendation,
          r.lastError ?? '',
        ]
          .map(csvCell)
          .join(','),
      );
    }
    return `${lines.join('\r\n')}\r\n`;
  }

  private simulateGoogle(input: CampaignComposerInput): CampaignSimulation {
    const resolved = this.requireGoogleSelection(input.contactSelection!);
    const ordered = orderGoogleContacts(
      resolved.contacts,
      input.batchOrder!,
      input.batchOrderSeed ?? 'simulation',
    );
    const classified = classifyGoogleContacts(ordered);
    const eligible = classified.filter((entry) => entry.eligibility === 'eligible');
    if (eligible.length === 0) {
      throw new CampaignValidationError([
        {
          path: 'contactSelection',
          message: 'A seleção não possui contatos elegíveis para envio.',
        },
      ]);
    }
    validateGoogleTemplate(input.messageTemplate);
    const batchCount = Math.ceil(eligible.length / input.batchSize!);
    const intervals = Math.max(0, eligible.length - batchCount);
    const batchWait = Math.max(0, batchCount - 1) * input.batchIntervalSeconds!;
    return {
      contactListName: 'Google Contacts',
      selectionSource: 'google',
      recipientCount: eligible.length,
      optedOutCount: classified.filter((entry) => entry.eligibility === 'opted_out').length,
      delayMinSeconds: input.delayMinSeconds,
      delayMaxSeconds: input.delayMaxSeconds,
      durationMinSeconds: intervals * input.delayMinSeconds + batchWait,
      durationAverageSeconds: Math.round(
        intervals * ((input.delayMinSeconds + input.delayMaxSeconds) / 2) + batchWait,
      ),
      durationMaxSeconds: intervals * input.delayMaxSeconds + batchWait,
      batchSize: input.batchSize!,
      batchCount,
      batchIntervalSeconds: input.batchIntervalSeconds!,
      batchOrder: input.batchOrder!,
      samples: eligible.slice(0, 3).map(({ contact }) => ({
        contactId: contact.id,
        name: contact.displayName,
        phone: contact.phone!,
        message: renderMessage(input.messageTemplate, contact.displayName),
      })),
    };
  }

  private requireGoogleSelection(
    definition: NonNullable<CampaignComposerInput['contactSelection']>,
  ): ResolvedContactSelectionWithContacts {
    if (!this.contactSelection) {
      throw new CampaignValidationError([
        { path: 'contactSelection', message: 'A seleção Google não está disponível.' },
      ]);
    }
    const resolved = this.contactSelection.resolveSelectionWithContacts(definition);
    if (resolved.contactIds.length !== resolved.contacts.length) {
      throw new CampaignValidationError([
        { path: 'contactSelection', message: 'Alguns contatos selecionados já não existem.' },
      ]);
    }
    return resolved;
  }

  private prepareGoogleDraft(campaign: CampaignSummary): CampaignSummary | undefined {
    if (!campaign.contactSelection) {
      throw new CampaignValidationError([
        { path: 'contactSelection', message: 'O rascunho não possui uma seleção Google válida.' },
      ]);
    }
    const resolved = this.requireGoogleSelection(campaign.contactSelection);
    if (!sameIds(resolved.contactIds, campaign.selectionResolvedIds ?? [])) {
      throw new CampaignValidationError([
        {
          path: 'contactSelection',
          message:
            'A agenda mudou desde a simulação. Revise e salve novamente a seleção antes de preparar.',
        },
      ]);
    }
    const ordered = orderGoogleContacts(
      resolved.contacts,
      campaign.batchOrder,
      campaign.batchOrderSeed ?? 'prepared',
    );
    const classified = classifyGoogleContacts(ordered);
    let eligiblePosition = 0;
    return this.repository.prepareDraft(
      campaign.id,
      classified.map(({ contact, eligibility }, index) => {
        const eligible = eligibility === 'eligible';
        const currentEligiblePosition = eligible ? eligiblePosition++ : 0;
        const reason = eligibilityReason(eligibility);
        return {
          googleContactId: contact.id,
          resourceName: contact.resourceName,
          name: contact.displayName,
          ...(contact.phone === undefined ? {} : { phone: contact.phone }),
          ...(contact.phoneOriginal === undefined ? {} : { phoneOriginal: contact.phoneOriginal }),
          ...(contact.phoneLabel === undefined ? {} : { phoneLabel: contact.phoneLabel }),
          renderedMessage: eligible
            ? renderMessage(campaign.messageTemplate, contact.displayName)
            : '',
          batchNumber: eligible ? Math.floor(currentEligiblePosition / campaign.batchSize) + 1 : 1,
          positionInBatch: eligible
            ? (currentEligiblePosition % campaign.batchSize) + 1
            : index + 1,
          eligibilityStatus: eligibility,
          ...(eligible
            ? {}
            : {
                resultCode: eligibility === 'opted_out' ? 'skipped_opt_out' : 'validation_failure',
                resultReason: reason,
              }),
          deletionRecommendation: deletionRecommendationFor(eligibility),
          ...(['missing_phone', 'invalid_phone'].includes(eligibility)
            ? { deletionReasonCode: eligibility }
            : {}),
        };
      }),
    );
  }

  private validate(
    input: CampaignComposerInput,
    requireName: boolean,
    currentMediaId?: number,
  ): CampaignComposerInput {
    const issues: Array<{ path: string; message: string }> = [];
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const messageTemplate =
      typeof input.messageTemplate === 'string' ? input.messageTemplate.trim() : '';
    const contactListId =
      input.contactListId === undefined ? undefined : Number(input.contactListId);
    const delayMinSeconds = Number(input.delayMinSeconds);
    const delayMaxSeconds = Number(input.delayMaxSeconds);
    const mediaId =
      input.mediaId === undefined || input.mediaId === null ? input.mediaId : Number(input.mediaId);

    if (requireName && !name) issues.push({ path: 'name', message: 'Informe o nome da campanha.' });
    if (
      !input.contactSelection &&
      (!Number.isSafeInteger(contactListId) || Number(contactListId) <= 0)
    ) {
      issues.push({ path: 'contactListId', message: 'Selecione uma lista de contatos.' });
    }
    if (input.contactSelection && !this.contactSelection) {
      issues.push({ path: 'contactSelection', message: 'A seleção Google não está disponível.' });
    }
    const batchSize = input.batchSize === undefined ? 100 : Number(input.batchSize);
    const batchIntervalSeconds =
      input.batchIntervalSeconds === undefined ? 0 : Number(input.batchIntervalSeconds);
    const batchOrder = input.batchOrder ?? 'name';
    const batchOrderSeed =
      batchOrder === 'random' ? (input.batchOrderSeed ?? randomUUID()) : undefined;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 100) {
      issues.push({ path: 'batchSize', message: 'O lote deve conter de 1 a 100 contatos.' });
    }
    if (
      !Number.isSafeInteger(batchIntervalSeconds) ||
      batchIntervalSeconds < 0 ||
      batchIntervalSeconds > 172_800
    ) {
      issues.push({
        path: 'batchIntervalSeconds',
        message: 'O intervalo entre lotes deve estar entre 0 e 48 horas.',
      });
    }
    if (!['name', 'google', 'random'].includes(batchOrder)) {
      issues.push({ path: 'batchOrder', message: 'Escolha uma ordenação de lotes válida.' });
    }
    if (!messageTemplate) issues.push({ path: 'messageTemplate', message: 'Escreva a mensagem.' });
    if (messageTemplate.length > MAX_MESSAGE_LENGTH) {
      issues.push({
        path: 'messageTemplate',
        message: `A mensagem excede ${MAX_MESSAGE_LENGTH} caracteres.`,
      });
    }

    if (
      !Number.isInteger(delayMinSeconds) ||
      delayMinSeconds < 1 ||
      delayMinSeconds > MAX_DELAY_SECONDS
    ) {
      issues.push({
        path: 'delayMinSeconds',
        message: 'O intervalo mínimo deve estar entre 1 e 3600 segundos.',
      });
    }
    if (
      !Number.isInteger(delayMaxSeconds) ||
      delayMaxSeconds < 1 ||
      delayMaxSeconds > MAX_DELAY_SECONDS
    ) {
      issues.push({
        path: 'delayMaxSeconds',
        message: 'O intervalo máximo deve estar entre 1 e 3600 segundos.',
      });
    }
    if (
      Number.isInteger(delayMinSeconds) &&
      Number.isInteger(delayMaxSeconds) &&
      delayMaxSeconds < delayMinSeconds
    ) {
      issues.push({
        path: 'delayMaxSeconds',
        message: 'O intervalo máximo não pode ser menor que o mínimo.',
      });
    }
    if (mediaId !== undefined && mediaId !== null) {
      const storedMedia =
        Number.isSafeInteger(mediaId) && mediaId > 0 ? this.media.findById(mediaId) : undefined;
      if (
        !storedMedia ||
        (storedMedia.status === 'attached' && storedMedia.id !== currentMediaId)
      ) {
        issues.push({ path: 'mediaId', message: 'A mídia selecionada não existe ou expirou.' });
      }
    }

    if (issues.length > 0) throw new CampaignValidationError(issues);
    return {
      ...(requireName ? { name } : input.name === undefined ? {} : { name }),
      ...(contactListId === undefined ? {} : { contactListId }),
      ...(input.contactSelection === undefined ? {} : { contactSelection: input.contactSelection }),
      messageTemplate,
      delayMinSeconds,
      delayMaxSeconds,
      batchSize,
      batchIntervalSeconds,
      batchOrder,
      ...(batchOrderSeed === undefined ? {} : { batchOrderSeed }),
      ...(mediaId === undefined ? {} : { mediaId }),
    };
  }
}

function orderGoogleContacts(
  contacts: ContactSearchItem[],
  order: NonNullable<CampaignComposerInput['batchOrder']>,
  seed: string,
): ContactSearchItem[] {
  const ordered = [...contacts];
  if (order === 'google') return ordered.sort((left, right) => left.id - right.id);
  if (order === 'random') {
    return ordered.sort(
      (left, right) => seededRank(seed, left.id) - seededRank(seed, right.id) || left.id - right.id,
    );
  }
  return ordered.sort(
    (left, right) =>
      left.displayName.localeCompare(right.displayName, 'pt-BR', { sensitivity: 'base' }) ||
      left.id - right.id,
  );
}

function seededRank(seed: string, id: number): number {
  let hash = 2_166_136_261;
  for (const character of `${seed}:${id}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function classifyGoogleContacts(
  contacts: ContactSearchItem[],
): Array<{ contact: ContactSearchItem; eligibility: RecipientEligibility }> {
  const phones = new Set<string>();
  return contacts.map((contact) => {
    let eligibility: RecipientEligibility;
    if (contact.remoteDeleted) eligibility = 'stale_google_contact';
    else if (contact.optedOut) eligibility = 'opted_out';
    else if (!contact.phone && contact.phoneOriginal) eligibility = 'invalid_phone';
    else if (!contact.phone) eligibility = 'missing_phone';
    else if (!contact.phoneValid) eligibility = 'invalid_phone';
    else if (phones.has(contact.phone)) eligibility = 'duplicate_phone';
    else {
      phones.add(contact.phone);
      eligibility = 'eligible';
    }
    return { contact, eligibility };
  });
}

function eligibilityReason(eligibility: RecipientEligibility): string {
  const reasons: Record<RecipientEligibility, string> = {
    eligible: 'Contato elegível para envio.',
    missing_phone: 'O contato não possui telefone utilizável.',
    invalid_phone: 'O telefone do contato é estruturalmente inválido.',
    duplicate_phone: 'Outro contato selecionado representa o mesmo telefone.',
    opted_out: 'O telefone está marcado como opt-out.',
    not_on_whatsapp: 'O WhatsApp informou que o número não está registrado.',
    stale_google_contact: 'O contato não existe mais na agenda Google.',
    unknown: 'Não foi possível concluir a validação do contato.',
  };
  return reasons[eligibility];
}

function sameIds(left: number[], right: number[]): boolean {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function validateGoogleTemplate(template: string): void {
  const unknown = [...template.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)]
    .map((match) => match[1]?.trim().toLowerCase())
    .filter((variable): variable is string => Boolean(variable))
    .filter((variable) => variable !== 'nome');
  if (unknown.length > 0) {
    throw new CampaignValidationError([
      {
        path: 'messageTemplate',
        message: `Variáveis ainda não disponíveis para contatos Google: ${[...new Set(unknown)].join(', ')}.`,
      },
    ]);
  }
}

export function renderMessage(
  template: string,
  name: string,
  data: Record<string, string> = {},
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey: string) => {
    const key = rawKey.trim().toLowerCase();
    if (key === 'nome') return name;
    // Variáveis de coluna extra: substitui pelo valor; ausência vira string vazia.
    return data[key] ?? '';
  });
}

/**
 * Escapa um valor para uma célula CSV com duas proteções:
 * 1. Anti CSV formula injection: valores iniciados por = + - @ (ou tab/CR) são
 *    prefixados com aspa simples, para não serem interpretados como fórmula ao
 *    abrir o arquivo em Excel/Sheets.
 * 2. RFC 4180: envolve em aspas quando contém aspas, vírgula ou quebra de linha,
 *    dobrando as aspas internas.
 */
function csvCell(value: string): string {
  let cell = value;
  if (/^[=+\-@\t\r]/.test(cell)) cell = `'${cell}`;
  if (/[",\r\n]/.test(cell)) return `"${cell.replace(/"/g, '""')}"`;
  return cell;
}
