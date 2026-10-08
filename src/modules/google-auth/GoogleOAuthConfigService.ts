import { randomUUID } from 'node:crypto';
import type { GoogleOAuthCredentialStore } from '../../providers/google/GoogleOAuthCredentialStore.js';
import type { GoogleOAuthConfigRepository } from './GoogleOAuthConfigRepository.js';

export interface GoogleOAuthCredentials {
  clientId: string;
  clientSecret: string;
  source: 'environment' | 'local';
}

export class GoogleOAuthConfigService {
  public constructor(
    private readonly repository: GoogleOAuthConfigRepository,
    private readonly secretStore?: GoogleOAuthCredentialStore,
  ) {}

  public async load(): Promise<GoogleOAuthCredentials | undefined> {
    const environment = environmentCredentials();
    if (environment) return environment;
    const stored = this.repository.get();
    if (!stored || !this.secretStore) return undefined;
    const clientSecret = await this.secretStore.load(stored.secretStoreKey);
    if (!clientSecret) return undefined;
    return { clientId: stored.clientId, clientSecret, source: 'local' };
  }

  public async status(): Promise<Record<string, unknown>> {
    const credentials = await this.load();
    const stored = this.repository.get();
    return {
      configured: Boolean(credentials),
      source: credentials?.source ?? null,
      clientId: credentials?.clientId ?? stored?.clientId ?? '',
      updatedAt: stored?.updatedAt ?? null,
      secureStorageAvailable: Boolean(this.secretStore),
      restartRequired: credentials?.source === 'local',
    };
  }

  public async save(clientIdInput: string, clientSecretInput: string): Promise<void> {
    if (environmentCredentials()) {
      throw Object.assign(
        new Error('As credenciais são controladas pelas variáveis de ambiente.'),
        {
          statusCode: 409,
        },
      );
    }
    if (!this.secretStore) {
      throw Object.assign(new Error('O armazenamento seguro não está disponível neste sistema.'), {
        statusCode: 503,
      });
    }
    const clientId = clientIdInput.trim();
    const clientSecret = clientSecretInput.trim();
    if (!clientId.endsWith('.apps.googleusercontent.com') || clientId.length > 500) {
      throw Object.assign(new Error('Informe um Client ID OAuth válido do Google.'), {
        statusCode: 422,
      });
    }
    if (!clientSecret || clientSecret.length > 1000) {
      throw Object.assign(new Error('Informe o Client secret do Google.'), { statusCode: 422 });
    }
    const previous = this.repository.get();
    const key = previous?.secretStoreKey ?? `google-oauth-client-${randomUUID()}`;
    await this.secretStore.save(key, clientSecret);
    this.repository.save(clientId, key);
  }

  public async delete(): Promise<void> {
    if (environmentCredentials()) {
      throw Object.assign(
        new Error('Remova as variáveis de ambiente para apagar a configuração.'),
        {
          statusCode: 409,
        },
      );
    }
    const stored = this.repository.get();
    if (stored && this.secretStore) await this.secretStore.delete(stored.secretStoreKey);
    this.repository.delete();
  }
}

function environmentCredentials(): GoogleOAuthCredentials | undefined {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret, source: 'environment' } : undefined;
}
