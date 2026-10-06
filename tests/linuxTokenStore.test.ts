import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LinuxSecretServiceGoogleTokenStore,
  type SecretToolRunner,
} from '../src/providers/google/token-store/LinuxSecretServiceGoogleTokenStore.js';

class FakeSecretTool implements SecretToolRunner {
  public value = '';
  public calls: Array<{ args: string[]; stdin?: string }> = [];
  public async run(args: string[], stdin?: string) {
    this.calls.push({ args, ...(stdin === undefined ? {} : { stdin }) });
    if (args[0] === 'store') this.value = stdin ?? '';
    if (args[0] === 'clear') this.value = '';
    return { stdout: args[0] === 'lookup' ? this.value : '', code: 0 };
  }
}

describe('LinuxSecretServiceGoogleTokenStore', () => {
  it('salva, recupera e remove tokens usando atributos fixos do Secret Service', async () => {
    const runner = new FakeSecretTool();
    const store = new LinuxSecretServiceGoogleTokenStore(runner);
    await store.save('google:subject', {
      accessToken: 'access',
      refreshToken: 'refresh',
      scope: [],
    });
    assert.equal((await store.load('google:subject'))?.refreshToken, 'refresh');
    await store.delete('google:subject');
    assert.equal(await store.load('google:subject'), undefined);
    assert.deepEqual(runner.calls[0]?.args.slice(-4), [
      'service',
      'WA-Delivery',
      'account',
      'google:subject',
    ]);
  });

  it('não confunde saída vazia com um token conectado', async () => {
    const store = new LinuxSecretServiceGoogleTokenStore({
      async run() {
        return { stdout: '', code: 1 };
      },
    });
    assert.equal(await store.load('missing'), undefined);
  });
});
