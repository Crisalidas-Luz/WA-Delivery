import type { GoogleOAuthCredentialStore } from '../GoogleOAuthCredentialStore.js';
import {
  SpawnSecretToolRunner,
  type SecretToolRunner,
} from './LinuxSecretServiceGoogleTokenStore.js';

export class LinuxSecretServiceCredentialStore implements GoogleOAuthCredentialStore {
  public constructor(private readonly runner: SecretToolRunner = new SpawnSecretToolRunner()) {}

  public async save(key: string, value: string): Promise<void> {
    const result = await this.runner.run(
      [
        'store',
        '--label=WA-Delivery Google OAuth Client',
        'service',
        'WA-Delivery OAuth Client',
        'account',
        key,
      ],
      value,
    );
    if (result.code !== 0) throw unavailableError();
  }

  public async load(key: string): Promise<string | undefined> {
    const result = await this.runner.run([
      'lookup',
      'service',
      'WA-Delivery OAuth Client',
      'account',
      key,
    ]);
    return result.code === 0 && result.stdout.trim() ? result.stdout.trim() : undefined;
  }

  public async delete(key: string): Promise<void> {
    const result = await this.runner.run([
      'clear',
      'service',
      'WA-Delivery OAuth Client',
      'account',
      key,
    ]);
    if (result.code !== 0 && result.code !== 1) throw unavailableError();
  }
}

function unavailableError(): Error {
  return new Error(
    'O cofre Secret Service não está disponível. Instale libsecret/secret-tool e desbloqueie o chaveiro da sessão.',
  );
}
