import type { DatabaseSync } from 'node:sqlite';
import type {
  CampaignComposerInput,
  CampaignRecipientSnapshot,
  CampaignSummary,
} from './campaignTypes.js';

interface CampaignRow {
  id: number;
  name: string;
  contact_list_id: number | null;
  contact_list_name: string | null;
  recipient_count: number;
  message_template: string;
  delay_min_seconds: number;
  delay_max_seconds: number;
  status: CampaignSummary['status'];
  created_at: string;
  updated_at: string;
  prepared_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  source_campaign_id: number | null;
  media_id: number | null;
  media_original_name: string | null;
  media_mimetype: string | null;
  media_kind: 'image' | 'video' | null;
  media_size_bytes: number | null;
  selection_source: CampaignSummary['selectionSource'];
  selection_filter_json: string | null;
  selection_summary_json: string | null;
  selection_resolved_ids_json: string | null;
  batch_size: number;
  batch_interval_seconds: number;
  batch_order: CampaignSummary['batchOrder'];
  batch_order_seed: string | null;
  current_batch_number: number;
  next_batch_at: string | null;
  batch_wait_remaining_seconds: number | null;
}

export interface DeletedDraft {
  mediaStorageName?: string;
}

export interface UpdatedDraft {
  campaign: CampaignSummary;
  removedMediaStorageName?: string;
}

interface RecipientRow {
  id: number;
  campaign_id: number;
  source_contact_id: number | null;
  google_contact_id: number | null;
  resource_name_snapshot: string | null;
  name: string;
  phone: string | null;
  phone_original: string | null;
  phone_label: string | null;
  render_data_json: string;
  rendered_message: string;
  batch_number: number;
  position_in_batch: number;
  eligibility_status: CampaignRecipientSnapshot['eligibilityStatus'];
  result_code: string | null;
  result_reason: string | null;
  deletion_recommendation: CampaignRecipientSnapshot['deletionRecommendation'];
  deletion_reason_code: string | null;
  status: CampaignRecipientSnapshot['status'];
  attempt_count: number;
  last_error: string | null;
  sent_at: string | null;
  updated_at: string | null;
}

export class CampaignRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public createDraft(input: CampaignComposerInput & { name: string }): CampaignSummary {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(
          `
        INSERT INTO campaigns (
          name, contact_list_id, message_template, delay_min_seconds, delay_max_seconds, media_id,
          selection_source, selection_filter_json, batch_size, batch_interval_seconds, batch_order,
          batch_order_seed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          input.name,
          input.contactListId ?? null,
          input.messageTemplate,
          input.delayMinSeconds,
          input.delayMaxSeconds,
          input.mediaId ?? null,
          input.contactSelection ? 'google' : 'local_list',
          input.contactSelection ? JSON.stringify(input.contactSelection) : null,
          input.batchSize ?? 100,
          input.batchIntervalSeconds ?? 0,
          input.batchOrder ?? 'name',
          input.batchOrderSeed ?? null,
        );
      if (input.mediaId !== undefined) {
        this.database
          .prepare("UPDATE media SET status = 'attached' WHERE id = ?")
          .run(input.mediaId);
      }
      this.database.exec('COMMIT');
      const created = this.findById(Number(result.lastInsertRowid));
      if (!created) throw new Error('O rascunho criado não pôde ser recuperado.');
      return created;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public list(): CampaignSummary[] {
    return (
      this.database
        .prepare(`${baseQuery()} ORDER BY campaigns.id DESC`)
        .all() as unknown as CampaignRow[]
    ).map(toSummary);
  }

  public findById(id: number): CampaignSummary | undefined {
    const row = this.database.prepare(baseQuery('WHERE campaigns.id = ?')).get(id) as unknown as
      CampaignRow | undefined;
    return row ? toSummary(row) : undefined;
  }

  public updateDraft(
    id: number,
    input: CampaignComposerInput & { name: string },
  ): UpdatedDraft | undefined {
    const existing = this.database
      .prepare(
        `
      SELECT campaigns.status, campaigns.media_id, media.storage_name
      FROM campaigns
      LEFT JOIN media ON media.id = campaigns.media_id
      WHERE campaigns.id = ?
    `,
      )
      .get(id) as
      | {
          status: CampaignSummary['status'];
          media_id: number | null;
          storage_name: string | null;
        }
      | undefined;
    if (!existing || existing.status !== 'draft') return undefined;

    const nextMediaId = input.mediaId ?? null;
    const mediaChanged = existing.media_id !== nextMediaId;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `
        UPDATE campaigns
        SET name = ?, contact_list_id = ?, message_template = ?, delay_min_seconds = ?,
            delay_max_seconds = ?, media_id = ?, selection_source = ?, selection_filter_json = ?,
            batch_size = ?, batch_interval_seconds = ?, batch_order = ?, batch_order_seed = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'draft'
      `,
        )
        .run(
          input.name,
          input.contactListId ?? null,
          input.messageTemplate,
          input.delayMinSeconds,
          input.delayMaxSeconds,
          nextMediaId,
          input.contactSelection ? 'google' : 'local_list',
          input.contactSelection ? JSON.stringify(input.contactSelection) : null,
          input.batchSize ?? 100,
          input.batchIntervalSeconds ?? 0,
          input.batchOrder ?? 'name',
          input.batchOrderSeed ?? null,
          id,
        );
      if (mediaChanged && nextMediaId !== null) {
        this.database.prepare("UPDATE media SET status = 'attached' WHERE id = ?").run(nextMediaId);
      }
      if (mediaChanged && existing.media_id !== null) {
        const references = this.database
          .prepare('SELECT COUNT(*) AS total FROM campaigns WHERE media_id = ?')
          .get(existing.media_id) as { total: number };
        if (references.total === 0)
          this.database.prepare('DELETE FROM media WHERE id = ?').run(existing.media_id);
      }
      this.database.exec('COMMIT');
      const campaign = this.findById(id);
      if (!campaign) throw new Error('O rascunho atualizado não pôde ser recuperado.');
      return {
        campaign,
        ...(mediaChanged && existing.storage_name && !this.mediaExists(existing.media_id)
          ? { removedMediaStorageName: existing.storage_name }
          : {}),
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public saveSelectionResolution(
    id: number,
    summary: Record<string, number>,
    resolvedIds: number[],
  ): void {
    this.database
      .prepare(
        `UPDATE campaigns SET selection_summary_json = ?, selection_resolved_ids_json = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'draft'`,
      )
      .run(JSON.stringify(summary), JSON.stringify(resolvedIds), id);
  }

  public prepareDraft(
    id: number,
    recipients: Array<{
      sourceContactId?: number;
      googleContactId?: number;
      resourceName?: string;
      name: string;
      phone?: string;
      phoneOriginal?: string;
      phoneLabel?: string;
      renderData?: Record<string, string>;
      renderedMessage: string;
      batchNumber?: number;
      positionInBatch?: number;
      eligibilityStatus?: CampaignRecipientSnapshot['eligibilityStatus'];
      resultCode?: string;
      resultReason?: string;
      deletionRecommendation?: CampaignRecipientSnapshot['deletionRecommendation'];
      deletionReasonCode?: string;
    }>,
  ): CampaignSummary | undefined {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const updated = this.database
        .prepare(
          `
        UPDATE campaigns SET status = 'ready', prepared_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'draft'
      `,
        )
        .run(id);
      if (updated.changes === 0) {
        this.database.exec('ROLLBACK');
        return undefined;
      }
      const insert = this.database.prepare(`
        INSERT INTO campaign_recipients (
          campaign_id, source_contact_id, google_contact_id, resource_name_snapshot, name, phone,
          phone_original, phone_label, render_data_json, rendered_message, batch_number, position_in_batch,
          eligibility_status, result_code, result_reason, deletion_recommendation,
          deletion_reason_code, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const recipient of recipients) {
        insert.run(
          id,
          recipient.sourceContactId ?? null,
          recipient.googleContactId ?? null,
          recipient.resourceName ?? null,
          recipient.name,
          recipient.phone ?? null,
          recipient.phoneOriginal ?? recipient.phone ?? null,
          recipient.phoneLabel ?? null,
          JSON.stringify(recipient.renderData ?? {}),
          recipient.renderedMessage,
          recipient.batchNumber ?? 1,
          recipient.positionInBatch ?? 1,
          recipient.eligibilityStatus ?? 'eligible',
          recipient.resultCode ?? null,
          recipient.resultReason ?? null,
          recipient.deletionRecommendation ?? 'not_recommended',
          recipient.deletionReasonCode ?? null,
          (recipient.eligibilityStatus ?? 'eligible') === 'eligible' ? 'pending' : 'skipped',
        );
      }
      this.database.exec('COMMIT');
      return this.findById(id);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public listRecipients(campaignId: number): CampaignRecipientSnapshot[] {
    return (
      this.database
        .prepare(
          `
      SELECT id, campaign_id, source_contact_id, google_contact_id, resource_name_snapshot,
        name, phone, phone_original, phone_label, render_data_json, rendered_message, batch_number,
        position_in_batch, eligibility_status, result_code, result_reason,
        deletion_recommendation, deletion_reason_code, status, attempt_count, last_error, sent_at,
        updated_at
      FROM campaign_recipients WHERE campaign_id = ? ORDER BY id
    `,
        )
        .all(campaignId) as unknown as RecipientRow[]
    ).map((row) => ({
      id: row.id,
      campaignId: row.campaign_id,
      ...(row.source_contact_id === null ? {} : { sourceContactId: row.source_contact_id }),
      ...(row.google_contact_id === null ? {} : { googleContactId: row.google_contact_id }),
      ...(row.resource_name_snapshot === null ? {} : { resourceName: row.resource_name_snapshot }),
      name: row.name,
      ...(row.phone === null ? {} : { phone: row.phone }),
      ...(row.phone_original === null ? {} : { phoneOriginal: row.phone_original }),
      ...(row.phone_label === null ? {} : { phoneLabel: row.phone_label }),
      renderData: parseRecord(row.render_data_json),
      renderedMessage: row.rendered_message,
      batchNumber: row.batch_number,
      positionInBatch: row.position_in_batch,
      eligibilityStatus: row.eligibility_status,
      ...(row.result_code === null ? {} : { resultCode: row.result_code }),
      ...(row.result_reason === null ? {} : { resultReason: row.result_reason }),
      deletionRecommendation: row.deletion_recommendation,
      ...(row.deletion_reason_code === null
        ? {}
        : { deletionReasonCode: row.deletion_reason_code }),
      status: row.status,
      attemptCount: row.attempt_count,
      ...(row.last_error === null ? {} : { lastError: row.last_error }),
      ...(row.sent_at === null ? {} : { sentAt: row.sent_at }),
      ...(row.updated_at === null ? {} : { updatedAt: row.updated_at }),
    }));
  }

  public deletionBlockReason(
    id: number,
  ): 'not_found' | 'running' | 'incomplete_deletion_job' | undefined {
    const campaign = this.database.prepare('SELECT status FROM campaigns WHERE id = ?').get(id) as
      { status: CampaignSummary['status'] } | undefined;
    if (!campaign) return 'not_found';
    if (campaign.status === 'running') return 'running';
    const incompleteDeletionJob = this.database
      .prepare(
        `SELECT 1 FROM contact_deletion_jobs WHERE campaign_id = ?
         AND status IN ('pending', 'running', 'partial', 'failed') LIMIT 1`,
      )
      .get(id);
    return incompleteDeletionJob ? 'incomplete_deletion_job' : undefined;
  }

  public deleteCampaign(id: number): DeletedDraft | undefined {
    const row = this.database
      .prepare(
        `
      SELECT campaigns.status, campaigns.media_id, media.storage_name
      FROM campaigns
      LEFT JOIN media ON media.id = campaigns.media_id
      WHERE campaigns.id = ?
    `,
      )
      .get(id) as
      | {
          status: CampaignSummary['status'];
          media_id: number | null;
          storage_name: string | null;
        }
      | undefined;
    // Uma campanha em execução não pode ser excluída; cancele-a antes.
    if (!row || this.deletionBlockReason(id)) return undefined;

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          "DELETE FROM contact_deletion_jobs WHERE campaign_id = ? AND status IN ('completed', 'cancelled')",
        )
        .run(id);
      this.database.prepare('DELETE FROM campaigns WHERE id = ?').run(id);
      let removedMedia = false;
      if (row.media_id !== null) {
        const references = this.database
          .prepare('SELECT COUNT(*) AS total FROM campaigns WHERE media_id = ?')
          .get(row.media_id) as { total: number };
        if (references.total === 0) {
          this.database.prepare('DELETE FROM media WHERE id = ?').run(row.media_id);
          removedMedia = true;
        }
      }
      this.database.exec('COMMIT');
      return {
        ...(row.storage_name === null || !removedMedia
          ? {}
          : { mediaStorageName: row.storage_name }),
      };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private mediaExists(id: number | null): boolean {
    if (id === null) return false;
    return Boolean(this.database.prepare('SELECT 1 FROM media WHERE id = ?').get(id));
  }

  /** Cria um rascunho vinculado; o snapshot só será gerado após nova revisão. */
  public createFollowUpDraft(source: CampaignSummary, pendingCount: number): CampaignSummary {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(
          `
        INSERT INTO campaigns (
          name, contact_list_id, message_template, delay_min_seconds, delay_max_seconds,
          media_id, source_campaign_id, status, selection_source,
          selection_filter_json, selection_summary_json, selection_resolved_ids_json,
          batch_size, batch_interval_seconds, batch_order, batch_order_seed
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)
      `,
        )
        .run(
          `${source.name} (reenvio)`,
          source.contactListId ?? null,
          source.messageTemplate,
          source.delayMinSeconds,
          source.delayMaxSeconds,
          source.media?.id ?? null,
          source.id,
          source.selectionSource,
          source.contactSelection ? JSON.stringify(source.contactSelection) : null,
          JSON.stringify(
            source.selectionSummary ?? { selected: pendingCount, eligible: pendingCount },
          ),
          source.selectionResolvedIds ? JSON.stringify(source.selectionResolvedIds) : null,
          source.batchSize,
          source.batchIntervalSeconds,
          source.batchOrder,
          source.batchOrderSeed ?? null,
        );
      const newId = Number(result.lastInsertRowid);
      if (source.media?.id !== undefined) {
        this.database
          .prepare("UPDATE media SET status = 'attached' WHERE id = ?")
          .run(source.media.id);
      }
      this.database.exec('COMMIT');
      const created = this.findById(newId);
      if (!created) throw new Error('A campanha de reenvio não pôde ser recuperada.');
      return created;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Remove campanhas finalizadas (completed/cancelled/failed) cujo término
   * ocorreu há mais de `retentionDays` dias. Retorna o storage das mídias
   * removidas para limpeza no serviço. Nunca remove campanhas ativas.
   */
  public deleteFinishedBefore(retentionDays: number): {
    deletedCount: number;
    mediaStorageNames: string[];
  } {
    const rows = this.database
      .prepare(
        `
      SELECT campaigns.id, media.storage_name
      FROM campaigns
      LEFT JOIN media ON media.id = campaigns.media_id
      WHERE campaigns.status IN ('completed', 'cancelled', 'failed')
        AND campaigns.finished_at IS NOT NULL
        AND campaigns.finished_at < datetime('now', ?)
        AND NOT EXISTS (
          SELECT 1 FROM contact_deletion_jobs deletion_job
          WHERE deletion_job.campaign_id = campaigns.id
            AND deletion_job.status IN ('pending', 'running', 'partial', 'failed')
        )
    `,
      )
      .all(`-${retentionDays} days`) as unknown as Array<{
      id: number;
      storage_name: string | null;
    }>;

    if (rows.length === 0) return { deletedCount: 0, mediaStorageNames: [] };

    this.database.exec('BEGIN IMMEDIATE');
    try {
      const deleteCampaign = this.database.prepare('DELETE FROM campaigns WHERE id = ?');
      const deleteDeletionJobs = this.database.prepare(
        "DELETE FROM contact_deletion_jobs WHERE campaign_id = ? AND status IN ('completed', 'cancelled')",
      );
      const deleteMedia = this.database.prepare(
        'DELETE FROM media WHERE id IN (SELECT media_id FROM campaigns WHERE id = ?)',
      );
      for (const row of rows) {
        deleteMedia.run(row.id);
        deleteDeletionJobs.run(row.id);
        deleteCampaign.run(row.id);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return {
      deletedCount: rows.length,
      mediaStorageNames: rows
        .map((r) => r.storage_name)
        .filter((name): name is string => Boolean(name)),
    };
  }
}

function baseQuery(where = ''): string {
  return `
    SELECT
      campaigns.id,
      campaigns.name,
      campaigns.contact_list_id,
      lists.name AS contact_list_name,
      campaigns.message_template,
      campaigns.delay_min_seconds,
      campaigns.delay_max_seconds,
      campaigns.status,
      campaigns.created_at,
      campaigns.updated_at
      , campaigns.prepared_at
      , campaigns.started_at
      , campaigns.finished_at
      , campaigns.source_campaign_id
      , campaigns.media_id
      , campaigns.selection_source
      , campaigns.selection_filter_json
      , campaigns.selection_summary_json
      , campaigns.selection_resolved_ids_json
      , campaigns.batch_size
      , campaigns.batch_interval_seconds
      , campaigns.batch_order
      , campaigns.batch_order_seed
      , campaigns.current_batch_number
      , campaigns.next_batch_at
      , campaigns.batch_wait_remaining_seconds
      , media.original_name AS media_original_name
      , media.mimetype AS media_mimetype
      , media.kind AS media_kind
      , media.size_bytes AS media_size_bytes
      , CASE WHEN campaigns.status = 'draft' AND campaigns.selection_source = 'google'
          THEN COALESCE(json_extract(campaigns.selection_summary_json, '$.eligible'), 0)
          WHEN campaigns.status = 'draft' AND campaigns.source_campaign_id IS NOT NULL
            THEN COALESCE(json_extract(campaigns.selection_summary_json, '$.eligible'), 0)
          WHEN campaigns.status = 'draft' THEN COUNT(members.id)
          ELSE (SELECT COUNT(*) FROM campaign_recipients recipients WHERE recipients.campaign_id = campaigns.id)
        END AS recipient_count
    FROM campaigns
    LEFT JOIN contact_lists lists ON lists.id = campaigns.contact_list_id
    LEFT JOIN contact_list_members members ON members.contact_list_id = lists.id
    LEFT JOIN media ON media.id = campaigns.media_id
    ${where}
    GROUP BY campaigns.id
  `;
}

function toSummary(row: CampaignRow): CampaignSummary {
  return {
    id: row.id,
    name: row.name,
    ...(row.contact_list_id === null ? {} : { contactListId: row.contact_list_id }),
    contactListName: row.contact_list_name ?? 'Google Contacts',
    recipientCount: row.recipient_count,
    messageTemplate: row.message_template,
    delayMinSeconds: row.delay_min_seconds,
    delayMaxSeconds: row.delay_max_seconds,
    selectionSource: row.selection_source,
    ...(row.selection_filter_json === null
      ? {}
      : {
          contactSelection: JSON.parse(row.selection_filter_json) as NonNullable<
            CampaignSummary['contactSelection']
          >,
        }),
    ...(row.selection_summary_json === null
      ? {}
      : { selectionSummary: JSON.parse(row.selection_summary_json) as Record<string, number> }),
    ...(row.selection_resolved_ids_json === null
      ? {}
      : { selectionResolvedIds: JSON.parse(row.selection_resolved_ids_json) as number[] }),
    batchSize: row.batch_size,
    batchIntervalSeconds: row.batch_interval_seconds,
    batchOrder: row.batch_order,
    ...(row.batch_order_seed === null ? {} : { batchOrderSeed: row.batch_order_seed }),
    currentBatchNumber: row.current_batch_number,
    ...(row.next_batch_at === null ? {} : { nextBatchAt: row.next_batch_at }),
    ...(row.batch_wait_remaining_seconds === null
      ? {}
      : { batchWaitRemainingSeconds: row.batch_wait_remaining_seconds }),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.prepared_at === null ? {} : { preparedAt: row.prepared_at }),
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    ...(row.source_campaign_id === null ? {} : { sourceCampaignId: row.source_campaign_id }),
    ...(row.media_id === null ||
    row.media_original_name === null ||
    row.media_mimetype === null ||
    row.media_kind === null ||
    row.media_size_bytes === null
      ? {}
      : {
          media: {
            id: row.media_id,
            originalName: row.media_original_name,
            mimetype: row.media_mimetype,
            kind: row.media_kind,
            sizeBytes: row.media_size_bytes,
          },
        }),
  };
}

function parseRecord(value: string): Record<string, string> {
  try {
    const parsed: unknown = JSON.parse(value);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}
