import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import type {
  GoogleAccountIdentity,
  GoogleContactRecord,
} from '../../providers/google/GooglePeopleProvider.js';

export interface GoogleSyncState {
  syncToken?: string;
  status: 'idle' | 'running' | 'completed' | 'failed';
  lastSyncType?: 'full' | 'incremental';
}

export interface StoredGoogleAccount {
  subject: string;
  email: string;
  displayName: string;
  tokenStoreKey: string;
  connectedAt: string;
  disconnectedAt?: string;
}

export interface NormalizedGooglePhone {
  label: string;
  rawValue: string;
  normalizedPhone?: string;
  primary: boolean;
  valid: boolean;
  validationReason?: string;
}

export class GoogleContactsRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public saveAccount(account: GoogleAccountIdentity, tokenStoreKey: string): void {
    this.database
      .prepare(
        `INSERT INTO google_accounts
          (id, google_subject, email, display_name, token_store_key)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
          google_subject = excluded.google_subject,
          email = excluded.email,
          display_name = excluded.display_name,
          token_store_key = excluded.token_store_key,
          disconnected_at = NULL,
          updated_at = CURRENT_TIMESTAMP`,
      )
      .run(account.subject, account.email, account.displayName, tokenStoreKey);
    this.database.prepare('INSERT OR IGNORE INTO google_sync_state (account_id) VALUES (1)').run();
  }

  public syncState(): GoogleSyncState | undefined {
    const row = this.database
      .prepare(
        `SELECT sync_token, status, last_sync_type
         FROM google_sync_state WHERE account_id = 1`,
      )
      .get() as
      | {
          sync_token: string | null;
          status: GoogleSyncState['status'];
          last_sync_type: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      status: row.status,
      ...(row.sync_token ? { syncToken: row.sync_token } : {}),
      ...(row.last_sync_type ? { lastSyncType: row.last_sync_type as 'full' | 'incremental' } : {}),
    };
  }

  public account(): StoredGoogleAccount | undefined {
    const row = this.database
      .prepare(
        `SELECT google_subject, email, display_name, token_store_key, connected_at, disconnected_at
         FROM google_accounts WHERE id = 1`,
      )
      .get() as
      | {
          google_subject: string;
          email: string;
          display_name: string;
          token_store_key: string;
          connected_at: string;
          disconnected_at: string | null;
        }
      | undefined;
    if (!row) return undefined;
    return {
      subject: row.google_subject,
      email: row.email,
      displayName: row.display_name,
      tokenStoreKey: row.token_store_key,
      connectedAt: row.connected_at,
      ...(row.disconnected_at ? { disconnectedAt: row.disconnected_at } : {}),
    };
  }

  public markDisconnected(): void {
    this.database
      .prepare(
        `UPDATE google_accounts SET disconnected_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP WHERE id = 1`,
      )
      .run();
  }

  public beginSync(type: 'full' | 'incremental'): void {
    this.database
      .prepare(
        `UPDATE google_sync_state SET status = 'running', last_sync_type = ?,
          last_error_code = NULL, last_error_message = NULL, created_count = 0,
          updated_count = 0, deleted_count = 0, updated_at = CURRENT_TIMESTAMP
         WHERE account_id = 1`,
      )
      .run(type);
  }

  public applyPage(
    contacts: Array<{ contact: GoogleContactRecord; phones: NormalizedGooglePhone[] }>,
  ): { created: number; updated: number; deleted: number } {
    let created = 0;
    let updated = 0;
    let deleted = 0;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const item of contacts) {
        const existing = this.database
          .prepare(
            'SELECT id, remote_deleted FROM google_contacts WHERE account_id = 1 AND resource_name = ?',
          )
          .get(item.contact.resourceName) as { id: number; remote_deleted: number } | undefined;
        const contactId = existing?.id ?? this.insertContact(item.contact);
        if (existing) {
          this.updateContact(contactId, item.contact);
          updated += 1;
        } else {
          created += 1;
        }
        if (item.contact.deleted) deleted += 1;
        this.replacePhones(contactId, item.phones);
        this.replaceLabels(contactId, item.contact.labels);
      }
      this.database.exec('COMMIT');
      return { created, updated, deleted };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public finishSync(
    type: 'full' | 'incremental',
    syncToken: string | undefined,
    counts: { created: number; updated: number; deleted: number },
  ): void {
    const timestampColumn = type === 'full' ? 'last_full_sync_at' : 'last_incremental_sync_at';
    this.database
      .prepare(
        `UPDATE google_sync_state SET status = 'completed', sync_token = ?,
          ${timestampColumn} = CURRENT_TIMESTAMP, created_count = ?, updated_count = ?,
          deleted_count = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = 1`,
      )
      .run(syncToken ?? null, counts.created, counts.updated, counts.deleted);
  }

  public failSync(code: string, message: string): void {
    this.database
      .prepare(
        `UPDATE google_sync_state SET status = 'failed', last_error_code = ?,
          last_error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE account_id = 1`,
      )
      .run(code, message);
  }

  public clearSyncToken(): void {
    this.database
      .prepare('UPDATE google_sync_state SET sync_token = NULL WHERE account_id = 1')
      .run();
  }

  private insertContact(contact: GoogleContactRecord): number {
    const result = this.database
      .prepare(
        `INSERT INTO google_contacts
          (account_id, resource_name, etag, display_name, given_name, middle_name, family_name,
           phonetic_name, honorific_prefix, honorific_suffix, nickname, file_as,
           organization_name, organization_title, organization_department, birthday, biography,
           raw_json, remote_deleted, remote_updated_at)
         VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      )
      .run(...contactValues(contact));
    return Number(result.lastInsertRowid);
  }

  private updateContact(id: number, contact: GoogleContactRecord): void {
    this.database
      .prepare(
        `UPDATE google_contacts SET etag = ?, display_name = ?, given_name = ?, middle_name = ?,
          family_name = ?, phonetic_name = ?, honorific_prefix = ?, honorific_suffix = ?,
          nickname = ?, file_as = ?, organization_name = ?, organization_title = ?,
          organization_department = ?, birthday = ?, biography = ?, raw_json = ?,
          remote_deleted = ?, remote_updated_at = CURRENT_TIMESTAMP,
          synced_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      )
      .run(...contactValues(contact).slice(1), id);
  }

  private replacePhones(contactId: number, phones: NormalizedGooglePhone[]): void {
    this.database
      .prepare('DELETE FROM google_contact_phones WHERE google_contact_id = ?')
      .run(contactId);
    const insert = this.database.prepare(
      `INSERT INTO google_contact_phones
        (google_contact_id, label, raw_value, normalized_phone, is_primary, is_valid, validation_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const phone of phones) {
      insert.run(
        contactId,
        phone.label,
        phone.rawValue,
        phone.normalizedPhone ?? null,
        phone.primary ? 1 : 0,
        phone.valid ? 1 : 0,
        phone.validationReason ?? null,
      );
    }
  }

  private replaceLabels(
    contactId: number,
    labels: Array<{ resourceName: string; name: string }>,
  ): void {
    this.database
      .prepare('DELETE FROM google_contact_labels WHERE google_contact_id = ?')
      .run(contactId);
    const insert = this.database.prepare(
      'INSERT INTO google_contact_labels (google_contact_id, resource_name, name) VALUES (?, ?, ?)',
    );
    for (const label of labels) insert.run(contactId, label.resourceName, label.name);
  }
}

function contactValues(contact: GoogleContactRecord): SQLInputValue[] {
  return [
    contact.resourceName,
    contact.etag ?? null,
    contact.displayName,
    contact.givenName,
    contact.middleName,
    contact.familyName,
    contact.phoneticName,
    contact.honorificPrefix,
    contact.honorificSuffix,
    contact.nickname,
    contact.fileAs,
    contact.organizationName,
    contact.organizationTitle,
    contact.organizationDepartment,
    contact.birthday ?? null,
    contact.biography,
    JSON.stringify(contact.raw),
    contact.deleted ? 1 : 0,
  ];
}
