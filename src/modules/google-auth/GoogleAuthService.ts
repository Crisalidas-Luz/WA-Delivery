import type {
  GoogleOAuthStart,
  GooglePeopleProvider,
  GoogleTokenSet,
  GoogleTokenStore,
} from '../../providers/google/GooglePeopleProvider.js';
import type { GoogleContactsRepository } from '../google-contacts/GoogleContactsRepository.js';
import type { GoogleContactsSyncService } from '../google-contacts/GoogleContactsSyncService.js';

export interface GoogleConnectionStatus {
  configured: true;
  connected: boolean;
  account?: { email: string; displayName: string; connectedAt: string };
  sync: {
    status: 'idle' | 'running' | 'completed' | 'failed';
    type?: 'full' | 'incremental';
  };
}

export class GoogleAuthService {
  public constructor(
    private readonly provider: GooglePeopleProvider,
    private readonly tokenStore: GoogleTokenStore,
    private readonly repository: GoogleContactsRepository,
    private readonly syncService: GoogleContactsSyncService,
    private readonly now: () => number = Date.now,
  ) {}

  public async status(): Promise<GoogleConnectionStatus> {
    const account = this.repository.account();
    const sync = this.repository.syncState();
    const connected = Boolean(
      account && !account.disconnectedAt && (await this.tokenStore.load(account.tokenStoreKey)),
    );
    return {
      configured: true,
      connected,
      ...(account && !account.disconnectedAt
        ? {
            account: {
              email: account.email,
              displayName: account.displayName,
              connectedAt: account.connectedAt,
            },
          }
        : {}),
      sync: {
        status: sync?.status ?? 'idle',
        ...(sync?.lastSyncType ? { type: sync.lastSyncType } : {}),
      },
    };
  }

  public startAuthorization(): Promise<GoogleOAuthStart> {
    return this.provider.createAuthorizationRequest();
  }

  public async finishAuthorization(code: string, state: string): Promise<GoogleConnectionStatus> {
    const { account, tokens } = await this.provider.finishAuthorization(code, state);
    const tokenStoreKey = `google:${account.subject}`;
    await this.tokenStore.save(tokenStoreKey, tokens);
    try {
      this.repository.saveAccount(account, tokenStoreKey);
    } catch (error) {
      await this.tokenStore.delete(tokenStoreKey);
      throw error;
    }
    return this.status();
  }

  public async synchronize(): Promise<{ created: number; updated: number; deleted: number }> {
    const tokens = await this.validTokens();
    return this.syncService.sync(tokens);
  }

  public async disconnect(): Promise<void> {
    const account = this.repository.account();
    if (!account) return;
    const tokens = await this.tokenStore.load(account.tokenStoreKey);
    if (tokens) await this.provider.revoke(tokens);
    await this.tokenStore.delete(account.tokenStoreKey);
    this.repository.markDisconnected();
  }

  private async validTokens(): Promise<GoogleTokenSet> {
    const account = this.repository.account();
    if (!account || account.disconnectedAt) throw new Error('Conecte uma conta Google primeiro.');
    const tokens = await this.tokenStore.load(account.tokenStoreKey);
    if (!tokens) throw new Error('A sessão Google não foi encontrada. Conecte a conta novamente.');
    const expiresAt = tokens.expiresAt ? Date.parse(tokens.expiresAt) : Number.POSITIVE_INFINITY;
    if (expiresAt > this.now() + 60_000) return tokens;
    const refreshed = await this.provider.refreshAccessToken(tokens);
    await this.tokenStore.save(account.tokenStoreKey, refreshed);
    return refreshed;
  }
}
