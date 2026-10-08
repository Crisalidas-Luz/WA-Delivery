import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openDatabase(filename: string): DatabaseSync {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });

  const database = new DatabaseSync(filename);
  database.function('fold_text', { deterministic: true }, (value: unknown) =>
    foldSearchText(value),
  );
  database.exec('PRAGMA foreign_keys = ON');
  if (filename !== ':memory:') database.exec('PRAGMA journal_mode = WAL');
  migrate(database);
  return database;
}

export function foldSearchText(value: unknown): string {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function migrate(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const appliedVersions = new Set(
    database
      .prepare('SELECT version FROM schema_migrations ORDER BY version')
      .all()
      .map((row) => Number(row.version)),
  );

  for (const migration of migrations) {
    if (appliedVersions.has(migration.version)) continue;

    if ('disableForeignKeys' in migration && migration.disableForeignKeys) {
      database.exec('PRAGMA foreign_keys = OFF');
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      if ('sql' in migration && migration.sql) database.exec(migration.sql);
      if ('run' in migration && migration.run) migration.run(database);
      database.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
      if ('disableForeignKeys' in migration && migration.disableForeignKeys) {
        const violation = database.prepare('PRAGMA foreign_key_check').get();
        if (violation)
          throw new Error(`A migration ${migration.version} violou uma chave estrangeira.`);
      }
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      if ('disableForeignKeys' in migration && migration.disableForeignKeys) {
        database.exec('PRAGMA foreign_keys = ON');
      }
    }
  }
}

const migrations = [
  {
    version: 1,
    sql: `
      CREATE TABLE contact_lists (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('manual', 'csv')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        normalized_phone TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE contact_list_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_list_id INTEGER NOT NULL REFERENCES contact_lists(id) ON DELETE CASCADE,
        contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE RESTRICT,
        name TEXT NOT NULL,
        source_data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (contact_list_id, contact_id)
      );

      CREATE INDEX idx_contact_list_members_list
        ON contact_list_members(contact_list_id);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        contact_list_id INTEGER NOT NULL REFERENCES contact_lists(id) ON DELETE RESTRICT,
        message_template TEXT NOT NULL,
        delay_min_seconds INTEGER NOT NULL,
        delay_max_seconds INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'ready', 'running', 'paused', 'completed', 'cancelled', 'failed')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_campaigns_contact_list ON campaigns(contact_list_id);
      CREATE INDEX idx_campaigns_status ON campaigns(status);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE media (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        storage_name TEXT NOT NULL UNIQUE,
        original_name TEXT NOT NULL,
        mimetype TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('image', 'video')),
        size_bytes INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'temporary' CHECK (status IN ('temporary', 'attached')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE campaigns ADD COLUMN media_id INTEGER REFERENCES media(id) ON DELETE SET NULL;
      CREATE INDEX idx_media_status_created ON media(status, created_at);
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE campaigns ADD COLUMN prepared_at TEXT;

      CREATE TABLE campaign_recipients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        source_contact_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        rendered_message TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (campaign_id, phone)
      );

      CREATE INDEX idx_campaign_recipients_campaign_status
        ON campaign_recipients(campaign_id, status);
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE campaigns ADD COLUMN started_at TEXT;
      ALTER TABLE campaigns ADD COLUMN finished_at TEXT;
      ALTER TABLE campaign_recipients ADD COLUMN attempt_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE campaign_recipients ADD COLUMN message_id TEXT;
      ALTER TABLE campaign_recipients ADD COLUMN sent_at TEXT;
      ALTER TABLE campaign_recipients ADD COLUMN last_error TEXT;
      ALTER TABLE campaign_recipients ADD COLUMN updated_at TEXT;
      UPDATE campaign_recipients SET updated_at = CURRENT_TIMESTAMP WHERE updated_at IS NULL;

      CREATE TABLE delivery_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
        recipient_id INTEGER NOT NULL REFERENCES campaign_recipients(id) ON DELETE CASCADE,
        attempt_number INTEGER NOT NULL,
        outcome TEXT NOT NULL CHECK (outcome IN ('sending', 'sent', 'failed', 'skipped')),
        message_id TEXT,
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TEXT
      );

      CREATE INDEX idx_delivery_attempts_campaign ON delivery_attempts(campaign_id, id);
    `,
  },
  {
    version: 6,
    sql: `
      ALTER TABLE campaigns ADD COLUMN source_campaign_id INTEGER
        REFERENCES campaigns(id) ON DELETE SET NULL;
      CREATE INDEX idx_campaigns_source ON campaigns(source_campaign_id);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE delivery_attempts ADD COLUMN error_kind TEXT
        CHECK (error_kind IN ('transient', 'permanent'));
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
  {
    version: 9,
    sql: `
      ALTER TABLE contacts ADD COLUMN opted_out INTEGER NOT NULL DEFAULT 0
        CHECK (opted_out IN (0, 1));
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE google_accounts (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        google_subject TEXT NOT NULL UNIQUE,
        email TEXT NOT NULL,
        display_name TEXT NOT NULL,
        token_store_key TEXT NOT NULL UNIQUE,
        connected_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        disconnected_at TEXT
      );

      CREATE TABLE google_sync_state (
        account_id INTEGER PRIMARY KEY REFERENCES google_accounts(id) ON DELETE CASCADE,
        sync_token TEXT,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK (status IN ('idle', 'running', 'completed', 'failed')),
        last_sync_type TEXT CHECK (last_sync_type IN ('full', 'incremental')),
        last_full_sync_at TEXT,
        last_incremental_sync_at TEXT,
        last_error_code TEXT,
        last_error_message TEXT,
        created_count INTEGER NOT NULL DEFAULT 0,
        updated_count INTEGER NOT NULL DEFAULT 0,
        deleted_count INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE google_contacts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id INTEGER NOT NULL REFERENCES google_accounts(id) ON DELETE CASCADE,
        resource_name TEXT NOT NULL,
        etag TEXT,
        display_name TEXT NOT NULL DEFAULT '',
        given_name TEXT NOT NULL DEFAULT '',
        middle_name TEXT NOT NULL DEFAULT '',
        family_name TEXT NOT NULL DEFAULT '',
        phonetic_name TEXT NOT NULL DEFAULT '',
        honorific_prefix TEXT NOT NULL DEFAULT '',
        honorific_suffix TEXT NOT NULL DEFAULT '',
        nickname TEXT NOT NULL DEFAULT '',
        file_as TEXT NOT NULL DEFAULT '',
        organization_name TEXT NOT NULL DEFAULT '',
        organization_title TEXT NOT NULL DEFAULT '',
        organization_department TEXT NOT NULL DEFAULT '',
        birthday TEXT,
        biography TEXT NOT NULL DEFAULT '',
        raw_json TEXT NOT NULL DEFAULT '{}',
        remote_deleted INTEGER NOT NULL DEFAULT 0 CHECK (remote_deleted IN (0, 1)),
        remote_updated_at TEXT,
        synced_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (account_id, resource_name)
      );

      CREATE INDEX idx_google_contacts_account_name
        ON google_contacts(account_id, display_name, id);
      CREATE INDEX idx_google_contacts_account_deleted
        ON google_contacts(account_id, remote_deleted);

      CREATE TABLE google_contact_phones (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        google_contact_id INTEGER NOT NULL REFERENCES google_contacts(id) ON DELETE CASCADE,
        label TEXT NOT NULL DEFAULT '',
        raw_value TEXT NOT NULL,
        normalized_phone TEXT,
        is_primary INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0, 1)),
        is_valid INTEGER NOT NULL DEFAULT 0 CHECK (is_valid IN (0, 1)),
        validation_reason TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_google_contact_phones_contact
        ON google_contact_phones(google_contact_id, is_primary DESC, id);
      CREATE INDEX idx_google_contact_phones_normalized
        ON google_contact_phones(normalized_phone);

      CREATE TABLE google_contact_labels (
        google_contact_id INTEGER NOT NULL REFERENCES google_contacts(id) ON DELETE CASCADE,
        resource_name TEXT NOT NULL,
        name TEXT NOT NULL,
        PRIMARY KEY (google_contact_id, resource_name)
      );

      CREATE INDEX idx_google_contact_labels_name ON google_contact_labels(name);

      CREATE TABLE saved_contact_filters (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        definition_json TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE contact_deletion_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER REFERENCES campaigns(id) ON DELETE RESTRICT,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'running', 'completed', 'partial', 'failed', 'cancelled')),
        requested_count INTEGER NOT NULL CHECK (requested_count >= 0),
        filter_snapshot_json TEXT NOT NULL DEFAULT '{}',
        confirmed_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE INDEX idx_contact_deletion_jobs_campaign
        ON contact_deletion_jobs(campaign_id, status);

      CREATE TABLE contact_deletion_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL REFERENCES contact_deletion_jobs(id) ON DELETE CASCADE,
        google_contact_id INTEGER REFERENCES google_contacts(id) ON DELETE SET NULL,
        resource_name_snapshot TEXT NOT NULL,
        display_name_snapshot TEXT NOT NULL DEFAULT '',
        phone_snapshot TEXT NOT NULL DEFAULT '',
        reason_code TEXT NOT NULL,
        evidence_json TEXT NOT NULL DEFAULT '{}',
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK (status IN ('pending', 'deleting', 'deleted', 'failed', 'already_missing', 'cancelled')),
        attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
        last_error_code TEXT,
        last_error_message TEXT,
        requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        deleted_at TEXT,
        verified_at TEXT,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (job_id, resource_name_snapshot)
      );

      CREATE INDEX idx_contact_deletion_items_job_status
        ON contact_deletion_items(job_id, status, id);
    `,
  },
  {
    version: 11,
    disableForeignKeys: true,
    run: migrateCampaignFlowV11,
  },
  {
    version: 12,
    sql: `
      ALTER TABLE campaigns ADD COLUMN batch_wait_remaining_seconds INTEGER
        CHECK (batch_wait_remaining_seconds IS NULL OR batch_wait_remaining_seconds >= 0);
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE google_oauth_config (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        client_id TEXT NOT NULL,
        client_secret_store_key TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `,
  },
] as const;

function migrateCampaignFlowV11(database: DatabaseSync): void {
  const campaignColumns = tableColumns(database, 'campaigns');
  database.exec(`
    CREATE TABLE campaigns_v11 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      contact_list_id INTEGER REFERENCES contact_lists(id) ON DELETE RESTRICT,
      message_template TEXT NOT NULL,
      delay_min_seconds INTEGER NOT NULL,
      delay_max_seconds INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'ready', 'running', 'paused', 'completed', 'cancelled', 'failed')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      media_id INTEGER REFERENCES media(id) ON DELETE SET NULL,
      prepared_at TEXT,
      started_at TEXT,
      finished_at TEXT,
      source_campaign_id INTEGER REFERENCES campaigns_v11(id) ON DELETE SET NULL,
      selection_source TEXT NOT NULL DEFAULT 'local_list'
        CHECK (selection_source IN ('local_list', 'google')),
      selection_filter_json TEXT,
      selection_summary_json TEXT,
      selection_resolved_ids_json TEXT,
      selection_included_ids_json TEXT,
      selection_excluded_ids_json TEXT,
      selection_finalized_at TEXT,
      batch_size INTEGER NOT NULL DEFAULT 100 CHECK (batch_size BETWEEN 1 AND 100),
      batch_interval_seconds INTEGER NOT NULL DEFAULT 0
        CHECK (batch_interval_seconds BETWEEN 0 AND 172800),
      batch_order TEXT NOT NULL DEFAULT 'name'
        CHECK (batch_order IN ('name', 'google', 'random')),
      batch_order_seed TEXT,
      current_batch_number INTEGER NOT NULL DEFAULT 1 CHECK (current_batch_number >= 1),
      next_batch_at TEXT
    );
  `);
  if (campaignColumns.size > 0) {
    const names = [
      'id',
      'name',
      'contact_list_id',
      'message_template',
      'delay_min_seconds',
      'delay_max_seconds',
      'status',
      'created_at',
      'updated_at',
      'media_id',
      'prepared_at',
      'started_at',
      'finished_at',
      'source_campaign_id',
    ];
    const fallbacks: Record<string, string> = {
      id: 'rowid',
      name: "''",
      contact_list_id: 'NULL',
      message_template: "''",
      delay_min_seconds: '1',
      delay_max_seconds: '1',
      status: "'draft'",
      created_at: 'CURRENT_TIMESTAMP',
      updated_at: 'CURRENT_TIMESTAMP',
      media_id: 'NULL',
      prepared_at: 'NULL',
      started_at: 'NULL',
      finished_at: 'NULL',
      source_campaign_id: 'NULL',
    };
    database.exec(
      `INSERT INTO campaigns_v11 (${names.join(', ')}) SELECT ${names
        .map((name) => (campaignColumns.has(name) ? name : fallbacks[name]))
        .join(', ')} FROM campaigns`,
    );
    database.exec('DROP TABLE campaigns');
  }
  database.exec(`
    ALTER TABLE campaigns_v11 RENAME TO campaigns;
    CREATE INDEX idx_campaigns_contact_list ON campaigns(contact_list_id);
    CREATE INDEX idx_campaigns_status ON campaigns(status);
    CREATE INDEX idx_campaigns_source ON campaigns(source_campaign_id);
  `);

  const recipientColumns = tableColumns(database, 'campaign_recipients');
  database.exec(`
    CREATE TABLE campaign_recipients_v11 (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      source_contact_id INTEGER,
      google_contact_id INTEGER REFERENCES google_contacts(id) ON DELETE SET NULL,
      resource_name_snapshot TEXT,
      name TEXT NOT NULL,
      phone TEXT,
      phone_original TEXT,
      phone_label TEXT,
      render_data_json TEXT NOT NULL DEFAULT '{}',
      rendered_message TEXT NOT NULL,
      batch_number INTEGER NOT NULL DEFAULT 1 CHECK (batch_number >= 1),
      position_in_batch INTEGER NOT NULL DEFAULT 1 CHECK (position_in_batch >= 1),
      eligibility_status TEXT NOT NULL DEFAULT 'eligible' CHECK (eligibility_status IN (
        'eligible', 'missing_phone', 'invalid_phone', 'duplicate_phone', 'opted_out',
        'not_on_whatsapp', 'stale_google_contact', 'unknown'
      )),
      result_code TEXT,
      result_reason TEXT,
      deletion_recommendation TEXT NOT NULL DEFAULT 'not_recommended'
        CHECK (deletion_recommendation IN ('recommended', 'review', 'not_recommended')),
      deletion_reason_code TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'sending', 'sent', 'failed', 'skipped')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      message_id TEXT,
      sent_at TEXT,
      last_error TEXT,
      updated_at TEXT
    );
  `);
  if (recipientColumns.size > 0) {
    const names = [
      'id',
      'campaign_id',
      'source_contact_id',
      'name',
      'phone',
      'rendered_message',
      'status',
      'created_at',
      'attempt_count',
      'message_id',
      'sent_at',
      'last_error',
      'updated_at',
    ];
    const fallbacks: Record<string, string> = {
      id: 'rowid',
      campaign_id: '0',
      source_contact_id: 'NULL',
      name: "''",
      phone: 'NULL',
      rendered_message: "''",
      status: "'pending'",
      created_at: 'CURRENT_TIMESTAMP',
      attempt_count: '0',
      message_id: 'NULL',
      sent_at: 'NULL',
      last_error: 'NULL',
      updated_at: 'CURRENT_TIMESTAMP',
    };
    database.exec(
      `INSERT INTO campaign_recipients_v11 (${names.join(', ')}) SELECT ${names
        .map((name) => (recipientColumns.has(name) ? name : fallbacks[name]))
        .join(', ')} FROM campaign_recipients`,
    );
    database.exec('DROP TABLE campaign_recipients');
  }
  database.exec(`
    ALTER TABLE campaign_recipients_v11 RENAME TO campaign_recipients;
    CREATE INDEX idx_campaign_recipients_campaign_status
      ON campaign_recipients(campaign_id, status);
    CREATE INDEX idx_campaign_recipients_batch
      ON campaign_recipients(campaign_id, batch_number, position_in_batch);
    CREATE UNIQUE INDEX idx_campaign_recipients_eligible_phone
      ON campaign_recipients(campaign_id, phone)
      WHERE eligibility_status = 'eligible' AND phone IS NOT NULL;
  `);
}

function tableColumns(database: DatabaseSync, table: string): Set<string> {
  return new Set(
    database
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );
}

/** Versão de schema mais recente conhecida (maior versão de migration). */
export const LATEST_SCHEMA_VERSION = migrations.reduce(
  (max, migration) => Math.max(max, migration.version),
  0,
);
