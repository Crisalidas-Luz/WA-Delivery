import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { LATEST_SCHEMA_VERSION, openDatabase } from '../src/database/database.js';

describe('migrações do banco', () => {
  it('cria a fundação Google e restringe a instalação a uma conta ativa', () => {
    const database = openDatabase(':memory:');
    try {
      assert.equal(
        database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version,
        LATEST_SCHEMA_VERSION,
      );
      database
        .prepare(
          `INSERT INTO google_accounts
            (id, google_subject, email, display_name, token_store_key)
           VALUES (1, ?, ?, ?, ?)`,
        )
        .run('subject-1', 'user@example.com', 'Usuário', 'google:subject-1');
      assert.throws(() =>
        database
          .prepare(
            `INSERT INTO google_accounts
              (id, google_subject, email, display_name, token_store_key)
             VALUES (2, ?, ?, ?, ?)`,
          )
          .run('subject-2', 'other@example.com', 'Outro', 'google:subject-2'),
      );
      database
        .prepare(
          `INSERT INTO google_contacts
            (account_id, resource_name, display_name, raw_json)
           VALUES (1, 'people/123', 'Ana', '{}')`,
        )
        .run();
      const contact = database
        .prepare('SELECT resource_name, display_name FROM google_contacts')
        .get() as { resource_name: string; display_name: string };
      assert.equal(contact.resource_name, 'people/123');
      assert.equal(contact.display_name, 'Ana');
    } finally {
      database.close();
    }
  });

  it('cria campanhas Google sem lista local e preserva inelegíveis no snapshot', () => {
    const database = openDatabase(':memory:');
    try {
      assert.equal(database.prepare('PRAGMA foreign_keys').get()?.foreign_keys, 1);
      const campaignId = Number(
        database
          .prepare(
            `INSERT INTO campaigns (
              name, contact_list_id, message_template, delay_min_seconds, delay_max_seconds,
              selection_source, selection_filter_json, selection_resolved_ids_json,
              batch_size, batch_interval_seconds, batch_order
            ) VALUES ('Google', NULL, 'Olá {{nome}}', 5, 10, 'google', '{}', '[1]', 50, 3600, 'name')`,
          )
          .run().lastInsertRowid,
      );
      database
        .prepare(
          `INSERT INTO campaign_recipients (
            campaign_id, source_contact_id, google_contact_id, resource_name_snapshot,
            name, phone, phone_original, rendered_message, batch_number, position_in_batch,
            eligibility_status, status
          ) VALUES (?, NULL, NULL, 'people/removed', 'Sem telefone', NULL, NULL, '', 1, 1,
            'missing_phone', 'skipped')`,
        )
        .run(campaignId);
      const row = database
        .prepare(
          `SELECT campaigns.selection_source, campaigns.batch_size,
            campaign_recipients.eligibility_status, campaign_recipients.phone
           FROM campaigns JOIN campaign_recipients
             ON campaign_recipients.campaign_id = campaigns.id
           WHERE campaigns.id = ?`,
        )
        .get(campaignId) as {
        selection_source: string;
        batch_size: number;
        eligibility_status: string;
        phone: null;
      };
      assert.equal(row.selection_source, 'google');
      assert.equal(row.batch_size, 50);
      assert.equal(row.eligibility_status, 'missing_phone');
      assert.equal(row.phone, null);
      assert.throws(() =>
        database
          .prepare(
            `INSERT INTO campaigns
              (name, message_template, delay_min_seconds, delay_max_seconds, batch_size)
             VALUES ('Inválida', 'x', 1, 1, 101)`,
          )
          .run(),
      );
    } finally {
      database.close();
    }
  });

  it('aplica a versão 5 sobre uma campanha preparada com destinatários', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-delivery-migration-'));
    const filename = join(directory, 'v4.db');
    const oldDatabase = new DatabaseSync(filename);
    try {
      oldDatabase.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_migrations (version, applied_at)
          VALUES (1, CURRENT_TIMESTAMP), (2, CURRENT_TIMESTAMP), (3, CURRENT_TIMESTAMP), (4, CURRENT_TIMESTAMP);
        CREATE TABLE campaigns (
          id INTEGER PRIMARY KEY, status TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY, normalized_phone TEXT NOT NULL UNIQUE, created_at TEXT
        );
        CREATE TABLE campaign_recipients (
          id INTEGER PRIMARY KEY,
          campaign_id INTEGER NOT NULL,
          source_contact_id INTEGER NOT NULL,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          rendered_message TEXT NOT NULL,
          status TEXT NOT NULL
        );
        INSERT INTO campaigns (id, status, updated_at) VALUES (1, 'ready', CURRENT_TIMESTAMP);
        INSERT INTO campaign_recipients (
          id, campaign_id, source_contact_id, name, phone, rendered_message, status
        ) VALUES (1, 1, 10, 'Ana', '5516999999999', 'Olá Ana!', 'pending');
      `);
    } finally {
      oldDatabase.close();
    }

    try {
      const migrated = openDatabase(filename);
      assert.equal(
        migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version,
        LATEST_SCHEMA_VERSION,
      );
      const recipient = migrated
        .prepare(
          `
        SELECT attempt_count, updated_at FROM campaign_recipients WHERE id = 1
      `,
        )
        .get() as { attempt_count: number; updated_at: string | null };
      assert.equal(recipient.attempt_count, 0);
      assert.ok(recipient.updated_at);
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('aplica a versão 6 sobre um banco já na versão 5 com campanhas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-delivery-migration-v6-'));
    const filename = join(directory, 'v5.db');
    // Monta manualmente um banco parado na versão 5 (sem source_campaign_id),
    // populado com uma campanha, para exercitar o upgrade sobre dados reais.
    const oldDatabase = new DatabaseSync(filename);
    try {
      oldDatabase.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_migrations (version, applied_at) VALUES
          (1, CURRENT_TIMESTAMP), (2, CURRENT_TIMESTAMP), (3, CURRENT_TIMESTAMP),
          (4, CURRENT_TIMESTAMP), (5, CURRENT_TIMESTAMP);
        CREATE TABLE campaigns (
          id INTEGER PRIMARY KEY, name TEXT NOT NULL, status TEXT NOT NULL, updated_at TEXT NOT NULL
        );
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY, normalized_phone TEXT NOT NULL UNIQUE, created_at TEXT
        );
        CREATE TABLE delivery_attempts (
          id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL, outcome TEXT NOT NULL, message_id TEXT,
          error_message TEXT, created_at TEXT, finished_at TEXT
        );
        INSERT INTO campaigns (id, name, status, updated_at)
          VALUES (1, 'Campanha', 'completed', CURRENT_TIMESTAMP);
      `);
    } finally {
      oldDatabase.close();
    }

    try {
      const migrated = openDatabase(filename);
      assert.equal(
        migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version,
        LATEST_SCHEMA_VERSION,
      );
      // A coluna nova existe e a campanha populada foi preservada.
      const row = migrated
        .prepare('SELECT name, source_campaign_id FROM campaigns WHERE id = 1')
        .get() as { name: string; source_campaign_id: number | null };
      assert.equal(row.name, 'Campanha');
      assert.equal(row.source_campaign_id, null);
      // A coluna aceita o vínculo de origem.
      migrated.prepare('UPDATE campaigns SET source_campaign_id = 1 WHERE id = 1').run();
      assert.equal(
        (
          migrated.prepare('SELECT source_campaign_id FROM campaigns WHERE id = 1').get() as {
            source_campaign_id: number;
          }
        ).source_campaign_id,
        1,
      );
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('aplica a versão 7 sobre um banco na versão 6 com tentativas', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-delivery-migration-v7-'));
    const filename = join(directory, 'v6.db');
    // Monta um banco parado na versão 6 (delivery_attempts sem error_kind).
    const oldDatabase = new DatabaseSync(filename);
    try {
      oldDatabase.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_migrations (version, applied_at) VALUES
          (1, CURRENT_TIMESTAMP), (2, CURRENT_TIMESTAMP), (3, CURRENT_TIMESTAMP),
          (4, CURRENT_TIMESTAMP), (5, CURRENT_TIMESTAMP), (6, CURRENT_TIMESTAMP);
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY, normalized_phone TEXT NOT NULL UNIQUE, created_at TEXT
        );
        CREATE TABLE delivery_attempts (
          id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL, recipient_id INTEGER NOT NULL,
          attempt_number INTEGER NOT NULL, outcome TEXT NOT NULL, message_id TEXT,
          error_message TEXT, created_at TEXT, finished_at TEXT
        );
        INSERT INTO delivery_attempts (id, campaign_id, recipient_id, attempt_number, outcome, error_message)
          VALUES (1, 1, 1, 1, 'failed', 'erro anterior');
      `);
    } finally {
      oldDatabase.close();
    }

    try {
      const migrated = openDatabase(filename);
      assert.equal(
        migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version,
        LATEST_SCHEMA_VERSION,
      );
      // A tentativa existente foi preservada e a coluna nova aceita a classificação.
      const before = migrated
        .prepare('SELECT error_kind FROM delivery_attempts WHERE id = 1')
        .get() as { error_kind: string | null };
      assert.equal(before.error_kind, null);
      migrated.prepare("UPDATE delivery_attempts SET error_kind = 'transient' WHERE id = 1").run();
      assert.equal(
        (
          migrated.prepare('SELECT error_kind FROM delivery_attempts WHERE id = 1').get() as {
            error_kind: string;
          }
        ).error_kind,
        'transient',
      );
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('aplica a versão 9 (opt-out) sobre um banco na versão 8 com contatos', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-delivery-migration-v9-'));
    const filename = join(directory, 'v8.db');
    const oldDatabase = new DatabaseSync(filename);
    try {
      oldDatabase.exec(`
        CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT);
        INSERT INTO schema_migrations (version, applied_at) VALUES
          (1, CURRENT_TIMESTAMP), (2, CURRENT_TIMESTAMP), (3, CURRENT_TIMESTAMP),
          (4, CURRENT_TIMESTAMP), (5, CURRENT_TIMESTAMP), (6, CURRENT_TIMESTAMP),
          (7, CURRENT_TIMESTAMP), (8, CURRENT_TIMESTAMP);
        CREATE TABLE contacts (
          id INTEGER PRIMARY KEY, normalized_phone TEXT NOT NULL UNIQUE, created_at TEXT
        );
        INSERT INTO contacts (id, normalized_phone) VALUES (1, '5516999999999');
      `);
    } finally {
      oldDatabase.close();
    }

    try {
      const migrated = openDatabase(filename);
      assert.equal(
        migrated.prepare('SELECT MAX(version) AS version FROM schema_migrations').get()?.version,
        LATEST_SCHEMA_VERSION,
      );
      // O contato existente foi preservado com opt-out = 0 (default seguro).
      const row = migrated
        .prepare('SELECT normalized_phone, opted_out FROM contacts WHERE id = 1')
        .get() as { normalized_phone: string; opted_out: number };
      assert.equal(row.normalized_phone, '5516999999999');
      assert.equal(row.opted_out, 0);
      migrated.prepare('UPDATE contacts SET opted_out = 1 WHERE id = 1').run();
      assert.equal(
        (
          migrated.prepare('SELECT opted_out FROM contacts WHERE id = 1').get() as {
            opted_out: number;
          }
        ).opted_out,
        1,
      );
      migrated.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
