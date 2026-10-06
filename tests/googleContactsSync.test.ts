import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/database/database.js';
import {
  GoogleSyncTokenExpiredError,
  type GoogleAccountIdentity,
  type GoogleContactRecord,
  type GoogleContactsPage,
  type GoogleOAuthStart,
  type GooglePeopleProvider,
  type GoogleTokenSet,
  type ListGoogleContactsInput,
} from '../src/providers/google/GooglePeopleProvider.js';
import { GoogleContactsRepository } from '../src/modules/google-contacts/GoogleContactsRepository.js';
import { GoogleContactsSyncService } from '../src/modules/google-contacts/GoogleContactsSyncService.js';

const TOKENS: GoogleTokenSet = {
  accessToken: 'access-test',
  refreshToken: 'refresh-test',
  scope: ['https://www.googleapis.com/auth/contacts'],
};

class FakeGooglePeopleProvider implements GooglePeopleProvider {
  public calls: ListGoogleContactsInput[] = [];
  public pages: GoogleContactsPage[] = [];
  public expireSyncToken = false;

  public async createAuthorizationRequest(): Promise<GoogleOAuthStart> {
    throw new Error('não usado');
  }
  public async finishAuthorization(): Promise<{
    account: GoogleAccountIdentity;
    tokens: GoogleTokenSet;
  }> {
    throw new Error('não usado');
  }
  public async refreshAccessToken(): Promise<GoogleTokenSet> {
    throw new Error('não usado');
  }
  public async revoke(): Promise<void> {}
  public async getContact(): Promise<GoogleContactRecord | undefined> {
    return undefined;
  }
  public async deleteContact(): Promise<void> {}

  public async listContacts(
    _tokens: GoogleTokenSet,
    input: ListGoogleContactsInput,
  ): Promise<GoogleContactsPage> {
    this.calls.push(input);
    if (input.syncToken && this.expireSyncToken) {
      this.expireSyncToken = false;
      throw new GoogleSyncTokenExpiredError();
    }
    const page = this.pages.shift();
    if (!page) throw new Error('Página fake ausente.');
    return page;
  }
}

function contact(resourceName: string, phone: string, deleted = false): GoogleContactRecord {
  return {
    resourceName,
    deleted,
    displayName: 'Ana Silva',
    givenName: 'Ana',
    middleName: '',
    familyName: 'Silva',
    phoneticName: '',
    honorificPrefix: '',
    honorificSuffix: '',
    nickname: '',
    fileAs: '',
    organizationName: 'Empresa',
    organizationTitle: '',
    organizationDepartment: '',
    biography: '',
    phones: [{ label: 'mobile', value: phone, primary: true }],
    labels: [{ resourceName: 'contactGroups/myContacts', name: 'myContacts' }],
    raw: { resourceName },
  };
}

function setup() {
  const database = openDatabase(':memory:');
  const repository = new GoogleContactsRepository(database);
  repository.saveAccount(
    { subject: 'subject-1', email: 'ana@example.com', displayName: 'Ana' },
    'google:subject-1',
  );
  const provider = new FakeGooglePeopleProvider();
  const service = new GoogleContactsSyncService(repository, provider);
  return { database, repository, provider, service };
}

describe('GoogleContactsSyncService', () => {
  it('sincroniza todas as páginas e persiste telefones e labels', async () => {
    const { database, repository, provider, service } = setup();
    try {
      provider.pages = [
        { contacts: [contact('people/1', '+55 16 99999-1111')], nextPageToken: 'page-2' },
        { contacts: [contact('people/2', '+55 16 99999-2222')], nextSyncToken: 'sync-1' },
      ];
      assert.deepEqual(await service.sync(TOKENS), { created: 2, updated: 0, deleted: 0 });
      assert.equal(provider.calls.length, 2);
      assert.equal(provider.calls[0]?.pageSize, 1000);
      assert.equal(provider.calls[1]?.pageToken, 'page-2');
      assert.equal(repository.syncState()?.syncToken, 'sync-1');
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM google_contacts').get()?.count,
        2,
      );
      const phone = database
        .prepare('SELECT normalized_phone, is_primary, is_valid FROM google_contact_phones LIMIT 1')
        .get() as { normalized_phone: string; is_primary: number; is_valid: number };
      assert.equal(phone.normalized_phone, '5516999991111');
      assert.equal(phone.is_primary, 1);
      assert.equal(phone.is_valid, 1);
      assert.equal(
        database.prepare('SELECT name FROM google_contact_labels LIMIT 1').get()?.name,
        'myContacts',
      );
    } finally {
      database.close();
    }
  });

  it('faz sincronização completa quando o sync token expira', async () => {
    const { database, repository, provider, service } = setup();
    try {
      provider.pages = [{ contacts: [], nextSyncToken: 'old-token' }];
      await service.sync(TOKENS);
      provider.expireSyncToken = true;
      provider.pages = [
        { contacts: [contact('people/3', '+5516999993333')], nextSyncToken: 'new-token' },
      ];
      assert.deepEqual(await service.sync(TOKENS), { created: 1, updated: 0, deleted: 0 });
      assert.equal(provider.calls.at(-2)?.syncToken, 'old-token');
      assert.equal(provider.calls.at(-1)?.syncToken, undefined);
      assert.equal(repository.syncState()?.syncToken, 'new-token');
      assert.equal(repository.syncState()?.lastSyncType, 'full');
    } finally {
      database.close();
    }
  });

  it('preserva telefone inválido com motivo em vez de descartá-lo', async () => {
    const { database, provider, service } = setup();
    try {
      provider.pages = [{ contacts: [contact('people/4', '123')], nextSyncToken: 'sync-2' }];
      await service.sync(TOKENS);
      const phone = database
        .prepare(
          'SELECT raw_value, normalized_phone, is_valid, validation_reason FROM google_contact_phones',
        )
        .get() as {
        raw_value: string;
        normalized_phone: string | null;
        is_valid: number;
        validation_reason: string;
      };
      assert.equal(phone.raw_value, '123');
      assert.equal(phone.normalized_phone, null);
      assert.equal(phone.is_valid, 0);
      assert.ok(phone.validation_reason);
    } finally {
      database.close();
    }
  });
});
