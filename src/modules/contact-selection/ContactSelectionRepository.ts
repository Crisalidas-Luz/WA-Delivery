import type { DatabaseSync } from 'node:sqlite';
import { compileContactFilter } from './ContactFilterSqlCompiler.js';

export interface ContactSearchInput {
  filter: unknown;
  page?: number;
  pageSize?: number;
  order?: 'name' | 'google';
}

export interface ContactSearchItem {
  id: number;
  resourceName: string;
  displayName: string;
  phone?: string;
  phoneLabel?: string;
  phoneValid: boolean;
  labels: string[];
  remoteDeleted: boolean;
}

export interface ContactSearchResult {
  items: ContactSearchItem[];
  total: number;
  page: number;
  pageSize: number;
}

export class ContactSelectionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public search(input: ContactSearchInput): ContactSearchResult {
    const compiled = compileContactFilter(input.filter);
    const page = positiveInteger(input.page, 1);
    const pageSize = Math.min(100, positiveInteger(input.pageSize, 25));
    const offset = (page - 1) * pageSize;
    const where = `gc.account_id = 1 AND gc.remote_deleted = 0 AND ${compiled.sql}`;
    const total = Number(
      this.database
        .prepare(`SELECT COUNT(*) AS total FROM google_contacts gc WHERE ${where}`)
        .get(...compiled.parameters)?.total ?? 0,
    );
    const order = input.order === 'google' ? 'gc.id ASC' : 'LOWER(gc.display_name) ASC, gc.id ASC';
    const rows = this.database
      .prepare(
        `SELECT gc.id, gc.resource_name, gc.display_name, gc.remote_deleted,
          (SELECT normalized_phone FROM google_contact_phones primary_phone
           WHERE primary_phone.google_contact_id = gc.id
           ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
           LIMIT 1) AS phone,
          (SELECT label FROM google_contact_phones primary_phone
           WHERE primary_phone.google_contact_id = gc.id
           ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
           LIMIT 1) AS phone_label,
          (SELECT is_valid FROM google_contact_phones primary_phone
           WHERE primary_phone.google_contact_id = gc.id
           ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
           LIMIT 1) AS phone_valid,
          (SELECT GROUP_CONCAT(name, char(31)) FROM google_contact_labels labels
           WHERE labels.google_contact_id = gc.id) AS labels
         FROM google_contacts gc WHERE ${where}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...compiled.parameters, pageSize, offset) as Array<{
      id: number;
      resource_name: string;
      display_name: string;
      remote_deleted: number;
      phone: string | null;
      phone_label: string | null;
      phone_valid: number | null;
      labels: string | null;
    }>;
    return {
      items: rows.map((row) => ({
        id: row.id,
        resourceName: row.resource_name,
        displayName: row.display_name,
        ...(row.phone ? { phone: row.phone } : {}),
        ...(row.phone_label ? { phoneLabel: row.phone_label } : {}),
        phoneValid: row.phone_valid === 1,
        labels: row.labels ? row.labels.split(String.fromCharCode(31)) : [],
        remoteDeleted: row.remote_deleted === 1,
      })),
      total,
      page,
      pageSize,
    };
  }
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
