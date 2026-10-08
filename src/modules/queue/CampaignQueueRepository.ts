import type { DatabaseSync } from 'node:sqlite';
import type { CampaignRecipientSnapshot, CampaignSummary } from '../campaigns/campaignTypes.js';
import type { QueueProgress } from './queueTypes.js';

interface QueueRecipient extends Omit<CampaignRecipientSnapshot, 'phone' | 'sourceContactId'> {
  phone: string;
  sourceContactId?: number;
}

export class CampaignQueueRepository {
  public constructor(private readonly database: DatabaseSync) {}

  /**
   * Recupera o estado após um reinício/encerramento abrupto, de forma idempotente:
   * - destinatários que ficaram em 'sending' viram 'failed' (marcados como
   *   interrompidos), pois não é possível confirmar se a mensagem chegou a ser
   *   enviada; nunca são reenviados silenciosamente (findNext só pega 'pending');
   * - as tentativas em aberto ('sending') são encerradas como falha transitória;
   * - campanhas 'running' voltam a 'paused'.
   * Rodar novamente não produz efeitos (nenhum registro em 'sending'/'running').
   * Retorna quantos destinatários foram marcados como interrompidos.
   */
  public recoverInterrupted(): number {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const error = 'Envio interrompido durante o encerramento; reenvie manualmente se necessário.';
      const interrupted = Number(
        this.database
          .prepare(
            `
        UPDATE campaign_recipients SET status = 'failed', last_error = ?,
          result_code = 'transient_failure_exhausted',
          result_reason = 'A execução foi interrompida e o envio não será repetido automaticamente.',
          deletion_recommendation = 'not_recommended', updated_at = CURRENT_TIMESTAMP
        WHERE status = 'sending'
      `,
          )
          .run(`[transient] ${error}`).changes,
      );
      this.database
        .prepare(
          `
        UPDATE delivery_attempts SET outcome = 'failed', error_message = ?, error_kind = 'transient', finished_at = CURRENT_TIMESTAMP
        WHERE outcome = 'sending'
      `,
        )
        .run(error);
      this.database
        .prepare(
          "UPDATE campaigns SET status = 'paused', updated_at = CURRENT_TIMESTAMP WHERE status = 'running'",
        )
        .run();
      this.database.exec('COMMIT');
      return interrupted;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public start(campaignId: number, allowedStatus: 'ready' | 'paused'): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const active = this.database
        .prepare("SELECT id FROM campaigns WHERE status = 'running' AND id != ?")
        .get(campaignId);
      if (active) {
        this.database.exec('ROLLBACK');
        return false;
      }
      const result = this.database
        .prepare(
          `
        UPDATE campaigns SET status = 'running', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = ?
      `,
        )
        .run(campaignId, allowedStatus);
      this.database.exec('COMMIT');
      return result.changes > 0;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public setStatus(
    campaignId: number,
    from: CampaignSummary['status'],
    to: CampaignSummary['status'],
  ): boolean {
    const finished = to === 'completed' || to === 'cancelled' || to === 'failed';
    return (
      this.database
        .prepare(
          `
      UPDATE campaigns SET status = ?, updated_at = CURRENT_TIMESTAMP,
        finished_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE finished_at END,
        next_batch_at = CASE WHEN ? THEN NULL ELSE next_batch_at END,
        batch_wait_remaining_seconds = CASE WHEN ? THEN NULL ELSE batch_wait_remaining_seconds END
      WHERE id = ? AND status = ?
    `,
        )
        .run(to, finished ? 1 : 0, finished ? 1 : 0, finished ? 1 : 0, campaignId, from).changes > 0
    );
  }

  public skipPending(campaignId: number): void {
    this.database
      .prepare(
        `
      UPDATE campaign_recipients SET status = 'skipped', last_error = 'Campanha cancelada.',
        result_code = 'skipped_cancelled', result_reason = 'A campanha foi cancelada pelo usuário.',
        deletion_recommendation = 'not_recommended', deletion_reason_code = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE campaign_id = ? AND status = 'pending'
    `,
      )
      .run(campaignId);
  }

  public scheduleNextBatch(campaignId: number, completedBatch: number, nextBatchAt: string): void {
    this.database
      .prepare(
        `UPDATE campaigns SET current_batch_number = ?, next_batch_at = ?,
          batch_wait_remaining_seconds = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`,
      )
      .run(completedBatch, nextBatchAt, campaignId);
  }

  public beginBatch(campaignId: number, batchNumber: number): void {
    this.database
      .prepare(
        `UPDATE campaigns SET current_batch_number = ?, next_batch_at = NULL,
          batch_wait_remaining_seconds = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'running'`,
      )
      .run(batchNumber, campaignId);
  }

  public freezeBatchWait(campaignId: number, nowMs: number): void {
    const row = this.database
      .prepare('SELECT next_batch_at FROM campaigns WHERE id = ?')
      .get(campaignId) as { next_batch_at: string | null } | undefined;
    if (!row?.next_batch_at) return;
    const remainingSeconds = Math.max(
      0,
      Math.ceil((Date.parse(row.next_batch_at) - nowMs) / 1_000),
    );
    this.database
      .prepare(
        `UPDATE campaigns SET next_batch_at = NULL, batch_wait_remaining_seconds = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(remainingSeconds, campaignId);
  }

  public restoreBatchWait(campaignId: number, nowMs: number): void {
    const row = this.database
      .prepare('SELECT batch_wait_remaining_seconds FROM campaigns WHERE id = ?')
      .get(campaignId) as { batch_wait_remaining_seconds: number | null } | undefined;
    if (
      row?.batch_wait_remaining_seconds === null ||
      row?.batch_wait_remaining_seconds === undefined
    )
      return;
    const nextBatchAt = new Date(nowMs + row.batch_wait_remaining_seconds * 1_000).toISOString();
    this.database
      .prepare(
        `UPDATE campaigns SET next_batch_at = ?, batch_wait_remaining_seconds = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(nextBatchAt, campaignId);
  }

  public findNext(campaignId: number): QueueRecipient | undefined {
    const row = this.database
      .prepare(
        `
      SELECT id, campaign_id, source_contact_id, name, phone, rendered_message, status,
        attempt_count, batch_number, position_in_batch, eligibility_status,
        deletion_recommendation
      FROM campaign_recipients WHERE campaign_id = ? AND status = 'pending'
        AND eligibility_status = 'eligible' AND phone IS NOT NULL
      ORDER BY batch_number, position_in_batch, id LIMIT 1
    `,
      )
      .get(campaignId) as
      | {
          id: number;
          campaign_id: number;
          source_contact_id: number | null;
          name: string;
          phone: string;
          rendered_message: string;
          status: QueueRecipient['status'];
          attempt_count: number;
          batch_number: number;
          position_in_batch: number;
          eligibility_status: QueueRecipient['eligibilityStatus'];
          deletion_recommendation: QueueRecipient['deletionRecommendation'];
        }
      | undefined;
    return row
      ? {
          id: row.id,
          campaignId: row.campaign_id,
          ...(row.source_contact_id === null ? {} : { sourceContactId: row.source_contact_id }),
          name: row.name,
          phone: row.phone,
          renderedMessage: row.rendered_message,
          status: row.status,
          attemptCount: row.attempt_count,
          batchNumber: row.batch_number,
          positionInBatch: row.position_in_batch,
          eligibilityStatus: row.eligibility_status,
          deletionRecommendation: row.deletion_recommendation,
        }
      : undefined;
  }

  public markSending(recipient: QueueRecipient): number {
    const attemptNumber = recipient.attemptCount + 1;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `
        UPDATE campaign_recipients SET status = 'sending', attempt_count = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending'
      `,
        )
        .run(attemptNumber, recipient.id);
      const result = this.database
        .prepare(
          `
        INSERT INTO delivery_attempts (campaign_id, recipient_id, attempt_number, outcome)
        VALUES (?, ?, ?, 'sending')
      `,
        )
        .run(recipient.campaignId, recipient.id, attemptNumber);
      this.database.exec('COMMIT');
      return Number(result.lastInsertRowid);
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public finishAttempt(
    attemptId: number,
    recipientId: number,
    outcome: 'sent' | 'failed' | 'skipped',
    details?: {
      messageId?: string;
      error?: string;
      kind?: 'transient' | 'permanent';
      resultCode?: string;
      resultReason?: string;
      eligibilityStatus?: CampaignRecipientSnapshot['eligibilityStatus'];
      deletionRecommendation?: CampaignRecipientSnapshot['deletionRecommendation'];
      deletionReasonCode?: string;
    },
  ): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `
        UPDATE campaign_recipients SET status = ?, message_id = ?,
          sent_at = CASE WHEN ? = 'sent' THEN CURRENT_TIMESTAMP ELSE NULL END,
          last_error = ?, result_code = ?, result_reason = ?,
          eligibility_status = COALESCE(?, eligibility_status),
          deletion_recommendation = COALESCE(?, deletion_recommendation),
          deletion_reason_code = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
      `,
        )
        .run(
          outcome,
          details?.messageId ?? null,
          outcome,
          details?.error ?? null,
          details?.resultCode ?? null,
          details?.resultReason ?? null,
          details?.eligibilityStatus ?? null,
          details?.deletionRecommendation ?? null,
          details?.deletionReasonCode ?? null,
          recipientId,
        );
      this.database
        .prepare(
          `
        UPDATE delivery_attempts SET outcome = ?, message_id = ?, error_message = ?, error_kind = ?, finished_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        )
        .run(
          outcome,
          details?.messageId ?? null,
          details?.error ?? null,
          details?.kind ?? null,
          attemptId,
        );
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  /**
   * Registra que a tentativa atual falhou de forma transitória, mas o
   * destinatário deve ser tentado novamente: a tentativa em `delivery_attempts`
   * é encerrada como 'failed' (mantendo o histórico e o error_kind) e o
   * destinatário volta para 'pending', preservando o attempt_count acumulado.
   */
  public retryLater(attemptId: number, recipientId: number, message: string): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `
        UPDATE campaign_recipients SET status = 'pending', last_error = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        )
        .run(message, recipientId);
      this.database
        .prepare(
          `
        UPDATE delivery_attempts SET outcome = 'failed', error_message = ?, error_kind = 'transient', finished_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `,
        )
        .run(message, attemptId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public progress(campaignId: number): QueueProgress | undefined {
    const row = this.database
      .prepare(
        `
      SELECT campaigns.status, campaigns.batch_size, campaigns.current_batch_number,
        campaigns.next_batch_at, campaigns.batch_wait_remaining_seconds,
        COUNT(recipients.id) AS total,
        SUM(CASE WHEN recipients.status IN ('pending', 'sending') THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN recipients.status = 'sent' THEN 1 ELSE 0 END) AS sent,
        SUM(CASE WHEN recipients.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN recipients.status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
        COALESCE(MAX(CASE WHEN recipients.eligibility_status = 'eligible'
          THEN recipients.batch_number ELSE 0 END), 0) AS total_batches
      FROM campaigns LEFT JOIN campaign_recipients recipients ON recipients.campaign_id = campaigns.id
      WHERE campaigns.id = ? GROUP BY campaigns.id
    `,
      )
      .get(campaignId) as
      | {
          status: QueueProgress['status'];
          total: number;
          pending: number;
          sent: number;
          failed: number;
          skipped: number;
          batch_size: number;
          current_batch_number: number;
          next_batch_at: string | null;
          batch_wait_remaining_seconds: number | null;
          total_batches: number;
        }
      | undefined;
    return row
      ? {
          campaignId,
          status: row.status,
          total: row.total,
          pending: row.pending,
          sent: row.sent,
          failed: row.failed,
          skipped: row.skipped,
          batchSize: row.batch_size,
          totalBatches: row.total_batches,
          currentBatchNumber: row.current_batch_number,
          ...(row.next_batch_at === null ? {} : { nextBatchAt: row.next_batch_at }),
          ...(row.batch_wait_remaining_seconds === null
            ? {}
            : { batchWaitRemainingSeconds: row.batch_wait_remaining_seconds }),
          waitingForNextBatch:
            row.next_batch_at !== null || row.batch_wait_remaining_seconds !== null,
        }
      : undefined;
  }
}
