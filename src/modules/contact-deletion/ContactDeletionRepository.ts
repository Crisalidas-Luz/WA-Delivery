import type { DatabaseSync } from 'node:sqlite';
import type {
  ContactDeletionItem,
  ContactDeletionItemStatus,
  ContactDeletionJob,
} from './contactDeletionTypes.js';

interface JobRow {
  id: number;
  campaign_id: number;
  status: ContactDeletionJob['status'];
  requested_count: number;
  filter_snapshot_json: string;
  confirmed_at: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ItemRow {
  id: number;
  job_id: number;
  google_contact_id: number | null;
  resource_name_snapshot: string;
  display_name_snapshot: string;
  phone_snapshot: string;
  reason_code: ContactDeletionItem['reasonCode'];
  evidence_json: string;
  status: ContactDeletionItemStatus;
  attempt_count: number;
  last_error_code: string | null;
  last_error_message: string | null;
  requested_at: string;
  deleted_at: string | null;
  verified_at: string | null;
  updated_at: string;
}

export class ContactDeletionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public create(
    campaignId: number,
    filterSnapshot: Record<string, unknown>,
    items: Array<{
      googleContactId: number;
      resourceName: string;
      displayName: string;
      phone: string;
      reasonCode: ContactDeletionItem['reasonCode'];
      evidence: Record<string, unknown>;
    }>,
  ): ContactDeletionJob {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = this.database
        .prepare(
          `INSERT INTO contact_deletion_jobs
            (campaign_id, requested_count, filter_snapshot_json, confirmed_at)
           VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
        )
        .run(campaignId, items.length, JSON.stringify(filterSnapshot));
      const jobId = Number(result.lastInsertRowid);
      const insert = this.database.prepare(
        `INSERT INTO contact_deletion_items
          (job_id, google_contact_id, resource_name_snapshot, display_name_snapshot,
           phone_snapshot, reason_code, evidence_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of items) {
        insert.run(
          jobId,
          item.googleContactId,
          item.resourceName,
          item.displayName,
          item.phone,
          item.reasonCode,
          JSON.stringify(item.evidence),
        );
      }
      this.database.exec('COMMIT');
      return this.find(jobId) as ContactDeletionJob;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public find(id: number): ContactDeletionJob | undefined {
    const row = this.database
      .prepare('SELECT * FROM contact_deletion_jobs WHERE id = ?')
      .get(id) as unknown as JobRow | undefined;
    if (!row) return undefined;
    const items = this.database
      .prepare('SELECT * FROM contact_deletion_items WHERE job_id = ? ORDER BY id')
      .all(id) as unknown as ItemRow[];
    return toJob(row, items);
  }

  public findLatestForCampaign(campaignId: number): ContactDeletionJob | undefined {
    const row = this.database
      .prepare(
        'SELECT id FROM contact_deletion_jobs WHERE campaign_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(campaignId) as { id: number } | undefined;
    return row ? this.find(row.id) : undefined;
  }

  public recoverInterrupted(): number {
    const jobs = this.database
      .prepare("SELECT id FROM contact_deletion_jobs WHERE status = 'running'")
      .all() as unknown as Array<{ id: number }>;
    for (const { id } of jobs) {
      this.database
        .prepare(
          `UPDATE contact_deletion_items SET status = 'failed',
            last_error_code = 'interrupted_unknown_outcome',
            last_error_message = 'A aplicação foi encerrada durante esta exclusão. Retome para verificar o contato antes de tentar novamente.',
            updated_at = CURRENT_TIMESTAMP
           WHERE job_id = ? AND status = 'deleting'`,
        )
        .run(id);
      this.complete(id);
    }
    return jobs.length;
  }

  public start(id: number): void {
    this.database
      .prepare(
        `UPDATE contact_deletion_jobs SET status = 'running', started_at = COALESCE(started_at,
          CURRENT_TIMESTAMP), finished_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(id);
  }

  public retryFailed(id: number): number {
    const result = this.database
      .prepare(
        `UPDATE contact_deletion_items SET status = 'pending', last_error_code = NULL,
          last_error_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE job_id = ? AND status = 'failed'`,
      )
      .run(id);
    return Number(result.changes);
  }

  public beginItem(id: number): void {
    this.database
      .prepare(
        `UPDATE contact_deletion_items SET status = 'deleting', attempt_count = attempt_count + 1,
          last_error_code = NULL, last_error_message = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'pending'`,
      )
      .run(id);
  }

  public finishItem(id: number, status: 'deleted' | 'already_missing', verified: boolean): void {
    this.database
      .prepare(
        `UPDATE contact_deletion_items SET status = ?, deleted_at = CURRENT_TIMESTAMP,
          verified_at = CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE verified_at END,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(status, verified ? 1 : 0, id);
  }

  public verifyItem(id: number): void {
    this.database
      .prepare(
        `UPDATE contact_deletion_items SET verified_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('deleted', 'already_missing')`,
      )
      .run(id);
  }

  public failItem(id: number, code: string, message: string): void {
    this.database
      .prepare(
        `UPDATE contact_deletion_items SET status = 'failed', last_error_code = ?,
          last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(code, message, id);
  }

  public cancelPending(id: number, code: string, message: string): void {
    this.database
      .prepare(
        `UPDATE contact_deletion_items SET status = 'cancelled', last_error_code = ?,
          last_error_message = ?, updated_at = CURRENT_TIMESTAMP
         WHERE job_id = ? AND status = 'pending'`,
      )
      .run(code, message, id);
  }

  public complete(id: number): void {
    const counts = this.database
      .prepare(
        `SELECT
          SUM(CASE WHEN status IN ('deleted', 'already_missing') THEN 1 ELSE 0 END) AS succeeded,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled
         FROM contact_deletion_items WHERE job_id = ?`,
      )
      .get(id) as { succeeded: number; failed: number; cancelled: number };
    const status: ContactDeletionJob['status'] =
      counts.succeeded > 0 && (counts.failed > 0 || counts.cancelled > 0)
        ? 'partial'
        : counts.failed > 0 || counts.cancelled > 0
          ? 'failed'
          : 'completed';
    this.database
      .prepare(
        `UPDATE contact_deletion_jobs SET status = ?, finished_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(status, id);
  }

  public failJob(id: number): void {
    this.database
      .prepare(
        `UPDATE contact_deletion_items SET status = 'failed',
          last_error_code = 'job_interrupted',
          last_error_message = 'O job foi interrompido. Retome para verificar e continuar.',
          updated_at = CURRENT_TIMESTAMP WHERE job_id = ? AND status = 'deleting'`,
      )
      .run(id);
    this.database
      .prepare(
        `UPDATE contact_deletion_jobs SET status = 'failed', finished_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(id);
  }
}

function toJob(row: JobRow, items: ItemRow[]): ContactDeletionJob {
  return {
    id: row.id,
    campaignId: row.campaign_id,
    status: row.status,
    requestedCount: row.requested_count,
    filterSnapshot: parseObject(row.filter_snapshot_json),
    confirmedAt: row.confirmed_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    items: items.map((item) => ({
      id: item.id,
      jobId: item.job_id,
      ...(item.google_contact_id === null ? {} : { googleContactId: item.google_contact_id }),
      resourceName: item.resource_name_snapshot,
      displayName: item.display_name_snapshot,
      phone: item.phone_snapshot,
      reasonCode: item.reason_code,
      evidence: parseObject(item.evidence_json),
      status: item.status,
      attemptCount: item.attempt_count,
      ...(item.last_error_code ? { lastErrorCode: item.last_error_code } : {}),
      ...(item.last_error_message ? { lastErrorMessage: item.last_error_message } : {}),
      requestedAt: item.requested_at,
      ...(item.deleted_at ? { deletedAt: item.deleted_at } : {}),
      ...(item.verified_at ? { verifiedAt: item.verified_at } : {}),
      updatedAt: item.updated_at,
    })),
  };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}
