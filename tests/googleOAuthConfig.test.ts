import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import Fastify from 'fastify';
import { openDatabase } from '../src/database/database.js';
import { GoogleOAuthConfigRepository } from '../src/modules/google-auth/GoogleOAuthConfigRepository.js';
import { GoogleOAuthConfigService } from '../src/modules/google-auth/GoogleOAuthConfigService.js';
import type { GoogleOAuthCredentialStore } from '../src/providers/google/GoogleOAuthCredentialStore.js';
import { registerGoogleRoutes } from '../src/web/googleRoutes.js';

class MemoryCredentialStore implements GoogleOAuthCredentialStore {
  public readonly values = new Map<string, string>();
  public async save(key: string, value: string): Promise<void> {
    this.values.set(key, value);
  }
  public async load(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }
  public async delete(key: string): Promise<void> {
    this.values.delete(key);
  }
}

afterEach(() => {
  delete process.env.GOOGLE_CLIENT_ID;
  delete process.env.GOOGLE_CLIENT_SECRET;
});

describe('configuração OAuth Google', () => {
  it('persiste somente o Client ID e a referência no SQLite', async () => {
    const database = openDatabase(':memory:');
    const store = new MemoryCredentialStore();
    const repository = new GoogleOAuthConfigRepository(database);
    const service = new GoogleOAuthConfigService(repository, store);
    try {
      await service.save('client.apps.googleusercontent.com', 'segredo-super-secreto');
      const row = repository.get();
      assert.equal(row?.clientId, 'client.apps.googleusercontent.com');
      assert.ok(row?.secretStoreKey);
      assert.equal(store.values.get(row!.secretStoreKey), 'segredo-super-secreto');
      const databaseText = JSON.stringify(
        database.prepare('SELECT * FROM google_oauth_config').all(),
      );
      assert.doesNotMatch(databaseText, /segredo-super-secreto/);
      assert.equal((await service.load())?.clientSecret, 'segredo-super-secreto');
    } finally {
      database.close();
    }
  });

  it('salva e apaga credenciais pelas rotas sem devolver o segredo', async () => {
    const database = openDatabase(':memory:');
    const store = new MemoryCredentialStore();
    const config = new GoogleOAuthConfigService(new GoogleOAuthConfigRepository(database), store);
    const server = Fastify();
    registerGoogleRoutes(server, undefined, config);
    try {
      const saved = await server.inject({
        method: 'PUT',
        url: '/api/google/config',
        payload: {
          clientId: 'client.apps.googleusercontent.com',
          clientSecret: 'nao-retornar',
        },
      });
      assert.equal(saved.statusCode, 200);
      assert.equal(saved.json().configured, true);
      assert.doesNotMatch(saved.body, /nao-retornar/);
      const removed = await server.inject({ method: 'DELETE', url: '/api/google/config' });
      assert.equal(removed.statusCode, 204);
      assert.equal((await config.status()).configured, false);
      assert.equal(store.values.size, 0);
    } finally {
      await server.close();
      database.close();
    }
  });

  it('rejeita Client ID inválido e respeita override por ambiente', async () => {
    const database = openDatabase(':memory:');
    const service = new GoogleOAuthConfigService(
      new GoogleOAuthConfigRepository(database),
      new MemoryCredentialStore(),
    );
    try {
      await assert.rejects(() => service.save('invalido', 'secret'), /Client ID/);
      process.env.GOOGLE_CLIENT_ID = 'env.apps.googleusercontent.com';
      process.env.GOOGLE_CLIENT_SECRET = 'env-secret';
      assert.equal((await service.load())?.source, 'environment');
      await assert.rejects(
        () => service.save('local.apps.googleusercontent.com', 'local-secret'),
        /variáveis de ambiente/,
      );
    } finally {
      database.close();
    }
  });
});
