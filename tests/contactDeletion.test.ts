import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import Fastify from 'fastify';
import { openDatabase } from '../src/database/database.js';
import { CampaignRepository } from '../src/modules/campaigns/CampaignRepository.js';
import { CampaignService } from '../src/modules/campaigns/CampaignService.js';
import { ContactDeletionRepository } from '../src/modules/contact-deletion/ContactDeletionRepository.js';
import { ContactDeletionService } from '../src/modules/contact-deletion/ContactDeletionService.js';
import { ContactRepository } from '../src/modules/contacts/ContactRepository.js';
import { ContactService } from '../src/modules/contacts/ContactService.js';
import type { GoogleAuthService } from '../src/modules/google-auth/GoogleAuthService.js';
import { GoogleContactsRepository } from '../src/modules/google-contacts/GoogleContactsRepository.js';
import { MediaRepository } from '../src/modules/media/MediaRepository.js';
import { MediaService } from '../src/modules/media/MediaService.js';
import { SettingsRepository } from '../src/modules/settings/SettingsRepository.js';
import { SettingsService } from '../src/modules/settings/SettingsService.js';
import type { GoogleContactRecord } from '../src/providers/google/GooglePeopleProvider.js';
import type {
  ConnectionListener,
  ConnectionState,
  DeliveryResult,
  MediaMessage,
  WhatsAppProvider,
} from '../src/providers/whatsapp/WhatsAppProvider.js';
import { registerContactDeletionRoutes } from '../src/web/contactDeletionRoutes.js';

class FakeWhatsApp implements WhatsAppProvider {
  public registered = false;
  public connect(): Promise<void> {
    return Promise.resolve();
  }
  public disconnect(): Promise<void> {
    return Promise.resolve();
  }
  public getConnectionState(): ConnectionState {
    return { status: 'connected' };
  }
  public onConnectionState(_listener: ConnectionListener): () => void {
    return () => undefined;
  }
  public hasSavedSession(): Promise<boolean> {
    return Promise.resolve(true);
  }
  public isRegisteredNumber(_phone: string): Promise<boolean> {
    return Promise.resolve(this.registered);
  }
  public sendText(_phone: string, _message: string): Promise<DeliveryResult> {
    throw new Error('not used');
  }
  public sendMedia(_phone: string, _media: MediaMessage): Promise<DeliveryResult> {
    throw new Error('not used');
  }
}

function contact(resourceName: string, phones: string[], deleted = false): GoogleContactRecord {
  return {
    resourceName,
    deleted,
    displayName: 'Contato teste',
    givenName: 'Contato',
    middleName: '',
    familyName: 'Teste',
    phoneticName: '',
    honorificPrefix: '',
    honorificSuffix: '',
    nickname: '',
    fileAs: '',
    organizationName: '',
    organizationTitle: '',
    organizationDepartment: '',
    biography: '',
    phones: phones.map((value) => ({ label: 'mobile', value, primary: true })),
    labels: [],
    raw: {},
  };
}

function setup(input: {
  reason: 'missing_phone' | 'invalid_phone' | 'not_on_whatsapp';
  phones: string[];
  recommendation?: 'recommended' | 'review' | 'not_recommended';
  deleteError?: Error;
}) {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO google_accounts
        (id, google_subject, email, display_name, token_store_key)
       VALUES (1, 'subject', 'user@example.com', 'User', 'google:subject')`,
    )
    .run();
  database.prepare('INSERT INTO google_sync_state (account_id) VALUES (1)').run();
  const googleContacts = new GoogleContactsRepository(database);
  const current = contact('people/test', input.phones);
  googleContacts.applyPage([
    {
      contact: current,
      phones: input.phones.map((rawValue) => ({
        label: 'mobile',
        rawValue,
        primary: true,
        valid: false,
        validationReason: 'inválido',
      })),
    },
  ]);
  const googleContactId = (
    database
      .prepare("SELECT id FROM google_contacts WHERE resource_name = 'people/test'")
      .get() as {
      id: number;
    }
  ).id;
  const campaignId = Number(
    database
      .prepare(
        `INSERT INTO campaigns
          (name, message_template, delay_min_seconds, delay_max_seconds, status, selection_source)
         VALUES ('Campanha', 'Olá', 1, 1, 'completed', 'google')`,
      )
      .run().lastInsertRowid,
  );
  const recipientId = Number(
    database
      .prepare(
        `INSERT INTO campaign_recipients
          (campaign_id, google_contact_id, resource_name_snapshot, name, phone, phone_original,
           rendered_message, eligibility_status, result_code, result_reason,
           deletion_recommendation, deletion_reason_code, status)
         VALUES (?, ?, 'people/test', 'Contato teste', ?, ?, 'Olá', ?, 'validation_failure',
           'Motivo testado', ?, ?, 'skipped')`,
      )
      .run(
        campaignId,
        googleContactId,
        input.phones[0] ?? null,
        input.phones[0] ?? null,
        input.reason,
        input.recommendation ?? 'recommended',
        input.reason,
      ).lastInsertRowid,
  );
  const contacts = new ContactService(new ContactRepository(database));
  const campaigns = new CampaignService(
    new CampaignRepository(database),
    contacts,
    new MediaService(new MediaRepository(database), '/tmp/wa-delivery-deletion-tests'),
  );
  let deleted = false;
  const google = {
    getContact: async () => (deleted ? undefined : current),
    deleteContact: async () => {
      if (input.deleteError) throw input.deleteError;
      deleted = true;
    },
    synchronize: async () => {
      if (deleted)
        googleContacts.applyPage([{ contact: contact('people/test', [], true), phones: [] }]);
      return { created: 0, updated: 1, deleted: deleted ? 1 : 0 };
    },
  } as unknown as GoogleAuthService;
  const whatsapp = new FakeWhatsApp();
  const service = new ContactDeletionService(
    new ContactDeletionRepository(database),
    campaigns,
    google,
    googleContacts,
    whatsapp,
    new SettingsService(new SettingsRepository(database)),
    async () => undefined,
  );
  return { database, service, whatsapp, campaignId, recipientId };
}

describe('ContactDeletionService', () => {
  it('exclui sequencialmente e confirma por sincronização uma evidência ainda válida', async () => {
    const { service, campaignId, recipientId } = setup({
      reason: 'invalid_phone',
      phones: ['123'],
    });
    const job = await service.createAndExecute(campaignId, {
      confirmed: true,
      recipientIds: [recipientId],
      filterSnapshot: { shortcut: 'invalid_phone' },
    });
    assert.equal(job.status, 'completed');
    assert.equal(job.items[0]?.status, 'deleted');
    assert.ok(job.items[0]?.verifiedAt);
    assert.deepEqual(job.filterSnapshot, { shortcut: 'invalid_phone' });
  });

  it('revalida no WhatsApp e bloqueia quando a evidência mudou', async () => {
    const { service, whatsapp, campaignId, recipientId } = setup({
      reason: 'not_on_whatsapp',
      phones: ['+55 16 99999-1111'],
    });
    whatsapp.registered = true;
    const job = await service.createAndExecute(campaignId, {
      confirmed: true,
      recipientIds: [recipientId],
    });
    assert.equal(job.status, 'failed');
    assert.equal(job.items[0]?.lastErrorCode, 'evidence_changed');
  });

  it('rejeita destinatário sem recomendação segura e exige confirmação explícita', async () => {
    const { service, campaignId, recipientId } = setup({
      reason: 'invalid_phone',
      phones: ['123'],
      recommendation: 'not_recommended',
    });
    await assert.rejects(
      service.createAndExecute(campaignId, { confirmed: true, recipientIds: [recipientId] }),
      /não possui evidência forte/,
    );
    await assert.rejects(
      service.createAndExecute(campaignId, { recipientIds: [recipientId] }),
      /Confirme explicitamente/,
    );
  });

  it('interrompe o job em erro de autorização e preserva erro seguro', async () => {
    const { service, campaignId, recipientId } = setup({
      reason: 'invalid_phone',
      phones: ['123'],
      deleteError: new Error('Não foi possível excluir o contato Google (HTTP 403).'),
    });
    const job = await service.createAndExecute(campaignId, {
      confirmed: true,
      recipientIds: [recipientId],
    });
    assert.equal(job.status, 'failed');
    assert.equal(job.items[0]?.lastErrorCode, 'google_authorization');
    assert.doesNotMatch(job.items[0]?.lastErrorMessage ?? '', /403/);
  });

  it('inicia em segundo plano e permite acompanhar pelo registro persistido', async () => {
    const { service, campaignId, recipientId } = setup({
      reason: 'invalid_phone',
      phones: ['123'],
    });
    const started = service.createAndStart(campaignId, {
      confirmed: true,
      recipientIds: [recipientId],
    });
    assert.equal(started.status, 'running');
    for (let index = 0; index < 20 && service.find(started.id)?.status === 'running'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    assert.equal(service.find(started.id)?.status, 'completed');
    assert.equal(service.findLatestForCampaign(campaignId)?.id, started.id);
  });

  it('recupera de forma conservadora uma exclusão interrompida', async () => {
    const { database, service, campaignId, recipientId } = setup({
      reason: 'invalid_phone',
      phones: ['123'],
    });
    const completed = await service.createAndExecute(campaignId, {
      confirmed: true,
      recipientIds: [recipientId],
    });
    database
      .prepare("UPDATE contact_deletion_jobs SET status = 'running' WHERE id = ?")
      .run(completed.id);
    database
      .prepare("UPDATE contact_deletion_items SET status = 'deleting' WHERE job_id = ?")
      .run(completed.id);
    assert.equal(service.recoverInterrupted(), 1);
    const recovered = service.find(completed.id);
    assert.equal(recovered?.status, 'failed');
    assert.equal(recovered?.items[0]?.status, 'failed');
    assert.equal(recovered?.items[0]?.lastErrorCode, 'interrupted_unknown_outcome');
  });
});

describe('contact deletion routes', () => {
  it('cria, consulta e repete jobs pelos endpoints persistidos', async () => {
    const { service, campaignId, recipientId } = setup({
      reason: 'invalid_phone',
      phones: ['123'],
      deleteError: new Error('Falha temporária ao excluir contato Google (HTTP 500).'),
    });
    const server = Fastify();
    registerContactDeletionRoutes(server, service);

    const created = await server.inject({
      method: 'POST',
      url: `/api/campaigns/${campaignId}/deletion-jobs`,
      payload: { confirmed: true, recipientIds: [recipientId] },
    });
    assert.equal(created.statusCode, 202);
    const jobId = created.json().id as number;
    assert.ok(jobId > 0);

    const latest = await server.inject({
      method: 'GET',
      url: `/api/campaigns/${campaignId}/deletion-jobs/latest`,
    });
    assert.equal(latest.statusCode, 200);
    assert.equal(latest.json().id, jobId);

    const found = await server.inject({
      method: 'GET',
      url: `/api/contact-deletion-jobs/${jobId}`,
    });
    assert.equal(found.statusCode, 200);

    for (let index = 0; index < 20 && service.find(jobId)?.status === 'running'; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const retried = await server.inject({
      method: 'POST',
      url: `/api/contact-deletion-jobs/${jobId}/retry`,
    });
    assert.equal(retried.statusCode, 200);
    assert.equal(retried.json().id, jobId);

    const invalid = await server.inject({
      method: 'GET',
      url: '/api/contact-deletion-jobs/not-an-id',
    });
    assert.equal(invalid.statusCode, 400);
    await server.close();
  });

  it('responde 503 quando a integração Google não está configurada', async () => {
    const server = Fastify();
    registerContactDeletionRoutes(server);
    const response = await server.inject({
      method: 'GET',
      url: '/api/contact-deletion-jobs/1',
    });
    assert.equal(response.statusCode, 503);
    await server.close();
  });
});
