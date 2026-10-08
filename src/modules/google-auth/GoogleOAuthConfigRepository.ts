import type { DatabaseSync } from 'node:sqlite';

export interface StoredGoogleOAuthConfig {
  clientId: string;
  secretStoreKey: string;
  updatedAt: string;
}

export class GoogleOAuthConfigRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public get(): StoredGoogleOAuthConfig | undefined {
    const row = this.database
      .prepare(
        `SELECT client_id, client_secret_store_key, updated_at
         FROM google_oauth_config WHERE id = 1`,
      )
      .get();
    if (!row) return undefined;
    return {
      clientId: String(row.client_id),
      secretStoreKey: String(row.client_secret_store_key),
      updatedAt: String(row.updated_at),
    };
  }

  public save(clientId: string, secretStoreKey: string): void {
    this.database
      .prepare(
        `INSERT INTO google_oauth_config (id, client_id, client_secret_store_key)
         VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           client_id = excluded.client_id,
           client_secret_store_key = excluded.client_secret_store_key,
           updated_at = CURRENT_TIMESTAMP`,
      )
      .run(clientId, secretStoreKey);
  }

  public delete(): void {
    this.database.prepare('DELETE FROM google_oauth_config WHERE id = 1').run();
  }
}
