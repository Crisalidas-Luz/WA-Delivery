import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GoogleOAuthCredentialStore } from '../GoogleOAuthCredentialStore.js';
import type { SecretProtector } from './ProtectedFileGoogleTokenStore.js';

export class ProtectedFileCredentialStore implements GoogleOAuthCredentialStore {
  public constructor(
    private readonly filename: string,
    private readonly protector: SecretProtector,
  ) {}

  public async save(key: string, value: string): Promise<void> {
    const values = await this.readAll();
    values[key] = value;
    await this.saveAll(values);
  }

  public async load(key: string): Promise<string | undefined> {
    return (await this.readAll())[key];
  }

  public async delete(key: string): Promise<void> {
    const values = await this.readAll();
    if (!(key in values)) return;
    delete values[key];
    if (Object.keys(values).length === 0) {
      await rm(this.filename, { force: true });
      return;
    }
    await this.saveAll(values);
  }

  private async saveAll(values: Record<string, string>): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true });
    const bytes = await this.protector.protect(Buffer.from(JSON.stringify(values), 'utf8'));
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, this.filename);
  }

  private async readAll(): Promise<Record<string, string>> {
    try {
      const raw = await this.protector.unprotect(await readFile(this.filename));
      const parsed: unknown = JSON.parse(raw.toString('utf8'));
      if (!isStringMap(parsed)) throw new Error('Credenciais OAuth locais corrompidas.');
      return parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
  }
}

function isStringMap(value: unknown): value is Record<string, string> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === 'string')
  );
}
