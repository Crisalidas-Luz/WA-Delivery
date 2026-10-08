import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/database/database.js';
import { GoogleAuthService } from '../src/modules/google-auth/GoogleAuthService.js';
import { GoogleContactsRepository } from '../src/modules/google-contacts/GoogleContactsRepository.js';
import { GoogleContactsSyncService } from '../src/modules/google-contacts/GoogleContactsSyncService.js';
import type {
  GoogleAccountIdentity,
  GoogleContactRecord,
  GoogleContactsPage,
  GoogleOAuthStart,
  GooglePeopleProvider,
  GoogleTokenSet,
  GoogleTokenStore,
  ListGoogleContactsInput,
} from '../src/providers/google/GooglePeopleProvider.js';
import { registerGoogleRoutes } from '../src/web/googleRoutes.js';

class MemoryTokenStore implements GoogleTokenStore {
  public values = new Map<string, GoogleTokenSet>();
  public async save(key: string, tokens: GoogleTokenSet) {
    this.values.set(key, tokens);
  }
  public async load(key: string) {
    return this.values.get(key);
  }
  public async delete(key: string) {
    this.values.delete(key);
  }
}

class AuthProvider implements GooglePeopleProvider {
  public revoked = 0;
  public refreshed = 0;
  public listed = 0;
  public listWait: Promise<void> | undefined;
  public async createAuthorizationRequest(): Promise<GoogleOAuthStart> {
    return {
      authorizationUrl: 'https://accounts.example/auth',
      state: 'state',
      expiresAt: new Date().toISOString(),
    };
  }
  public async finishAuthorization(): Promise<{
    account: GoogleAccountIdentity;
    tokens: GoogleTokenSet;
  }> {
    return {
      account: { subject: 'sub', email: 'user@example.com', displayName: 'User' },
      tokens: {
        accessToken: 'old',
        refreshToken: 'refresh',
        expiresAt: new Date(0).toISOString(),
        scope: [],
      },
    };
  }
  public async refreshAccessToken(tokens: GoogleTokenSet): Promise<GoogleTokenSet> {
    this.refreshed += 1;
    return {
      ...tokens,
      accessToken: 'new',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
  }
  public async revoke(): Promise<void> {
    this.revoked += 1;
  }
  public async listContacts(
    _tokens: GoogleTokenSet,
    _input: ListGoogleContactsInput,
  ): Promise<GoogleContactsPage> {
    this.listed += 1;
    await this.listWait;
    return { contacts: [], nextSyncToken: 'sync' };
  }
  public async getContact(): Promise<GoogleContactRecord | undefined> {
    return undefined;
  }
  public async deleteContact(): Promise<void> {}
}

function setup() {
  const database = openDatabase(':memory:');
  const repository = new GoogleContactsRepository(database);
  const provider = new AuthProvider();
  const store = new MemoryTokenStore();
  const service = new GoogleAuthService(
    provider,
    store,
    repository,
    new GoogleContactsSyncService(repository, provider),
  );
  return { database, repository, provider, store, service };
}

async function waitForSync(service: GoogleAuthService) {
  for (let index = 0; index < 20; index += 1) {
    const status = await service.status();
    if (status.sync.status !== 'running') return status;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('A sincronização Google não terminou no teste.');
}

describe('GoogleAuthService', () => {
  it('conclui login, persiste sessão e renova token expirado ao sincronizar', async () => {
    const { database, provider, store, service } = setup();
    try {
      await service.finishAuthorization('code', 'state');
      assert.equal((await service.status()).connected, true);
      assert.equal(provider.listed, 1);
      assert.equal(provider.refreshed, 1);
      assert.equal(store.values.get('google:sub')?.accessToken, 'new');
      assert.equal((await waitForSync(service)).sync.status, 'completed');
      await service.synchronize();
      assert.equal(provider.refreshed, 1);
      assert.equal(store.values.get('google:sub')?.accessToken, 'new');
    } finally {
      database.close();
    }
  });

  it('revoga, apaga o token e marca a conta como desconectada', async () => {
    const { database, provider, store, repository, service } = setup();
    try {
      await service.finishAuthorization('code', 'state');
      await service.disconnect();
      assert.equal(provider.revoked, 1);
      assert.equal(store.values.size, 0);
      assert.ok(repository.account()?.disconnectedAt);
      assert.equal((await service.status()).connected, false);
    } finally {
      database.close();
    }
  });
});

describe('rotas Google', () => {
  it('expõe status não configurado e recusa iniciar OAuth', async () => {
    const server = Fastify();
    registerGoogleRoutes(server);
    const status = await server.inject({ method: 'GET', url: '/api/google/status' });
    assert.deepEqual(status.json(), {
      configured: false,
      connected: false,
      sync: { status: 'idle', created: 0, updated: 0, deleted: 0 },
    });
    const start = await server.inject({ method: 'POST', url: '/api/google/oauth/start' });
    assert.equal(start.statusCode, 503);
    await server.close();
  });

  it('inicia OAuth e valida callback incompleto', async () => {
    const { database, service } = setup();
    const server = Fastify();
    registerGoogleRoutes(server, service);
    try {
      const start = await server.inject({ method: 'POST', url: '/api/google/oauth/start' });
      assert.equal(start.statusCode, 202);
      assert.equal(start.json().state, 'state');
      const callback = await server.inject({ method: 'GET', url: '/api/google/oauth/callback' });
      assert.equal(callback.statusCode, 400);
      const denied = await server.inject({
        method: 'GET',
        url: '/api/google/oauth/callback?error=access_denied',
      });
      assert.equal(denied.statusCode, 400);
      assert.match(denied.json().message, /cancelado|recusado/);
    } finally {
      await server.close();
      database.close();
    }
  });

  it('inicia sincronização assíncrona e expõe o estado em rota própria', async () => {
    const { database, provider, service } = setup();
    await service.finishAuthorization('code', 'state');
    await waitForSync(service);
    let release: (() => void) | undefined;
    provider.listWait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = Fastify();
    registerGoogleRoutes(server, service);
    try {
      const started = await server.inject({ method: 'POST', url: '/api/google/sync' });
      assert.equal(started.statusCode, 202);
      assert.equal(started.json().sync.status, 'running');
      release?.();
      provider.listWait = undefined;
      await waitForSync(service);
      const status = await server.inject({ method: 'GET', url: '/api/google/sync/status' });
      assert.equal(status.statusCode, 200);
      assert.equal(status.json().status, 'completed');
    } finally {
      await server.close();
      database.close();
    }
  });
});
