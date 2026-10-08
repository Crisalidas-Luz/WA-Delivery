export interface GoogleOAuthCredentialStore {
  save(key: string, value: string): Promise<void>;
  load(key: string): Promise<string | undefined>;
  delete(key: string): Promise<void>;
}
