import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import {
  ProtectedFileGoogleTokenStore,
  type SecretProtector,
} from '../src/providers/google/token-store/ProtectedFileGoogleTokenStore.js';
import { WindowsDpapiSecretProtector } from '../src/providers/google/token-store/WindowsDpapiSecretProtector.js';

class ReversingProtector implements SecretProtector {
  public async protect(value: Buffer): Promise<Buffer> {
    return Buffer.from(value).reverse();
  }
  public async unprotect(value: Buffer): Promise<Buffer> {
    return Buffer.from(value).reverse();
  }
}

describe('ProtectedFileGoogleTokenStore', () => {
  it('persiste tokens protegidos entre instâncias sem expor o conteúdo', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-google-tokens-'));
    const filename = join(directory, 'tokens.bin');
    try {
      const store = new ProtectedFileGoogleTokenStore(filename, new ReversingProtector());
      await store.save('google:1', {
        accessToken: 'access-secret',
        refreshToken: 'refresh-secret',
        scope: ['contacts'],
      });
      const stored = await readFile(filename, 'utf8');
      assert.ok(!stored.includes('access-secret'));
      const reopened = new ProtectedFileGoogleTokenStore(filename, new ReversingProtector());
      assert.equal((await reopened.load('google:1'))?.refreshToken, 'refresh-secret');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('remove somente a chave solicitada e apaga o arquivo quando ficar vazio', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'wa-google-tokens-delete-'));
    const filename = join(directory, 'tokens.bin');
    try {
      const store = new ProtectedFileGoogleTokenStore(filename, new ReversingProtector());
      await store.save('one', { accessToken: 'a', scope: [] });
      await store.save('two', { accessToken: 'b', scope: [] });
      await store.delete('one');
      assert.equal(await store.load('one'), undefined);
      assert.equal((await store.load('two'))?.accessToken, 'b');
      await store.delete('two');
      assert.equal(await store.load('two'), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

describe('WindowsDpapiSecretProtector', () => {
  it(
    'carrega o assembly necessário e protege dados com o usuário atual',
    { skip: process.platform !== 'win32' },
    async () => {
      const protector = new WindowsDpapiSecretProtector();
      const plaintext = Buffer.from('dpapi-regression-test', 'utf8');
      const protectedBytes = await protector.protect(plaintext);
      assert.notDeepEqual(protectedBytes, plaintext);
      assert.equal(
        (await protector.unprotect(protectedBytes)).toString('utf8'),
        plaintext.toString(),
      );
    },
  );
});
