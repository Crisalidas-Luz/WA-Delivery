import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { GoogleTokenSet, GoogleTokenStore } from '../GooglePeopleProvider.js';

export interface SecretProtector {
  protect(value: Buffer): Promise<Buffer>;
  unprotect(value: Buffer): Promise<Buffer>;
}

export class ProtectedFileGoogleTokenStore implements GoogleTokenStore {
  public constructor(
    private readonly filename: string,
    private readonly protector: SecretProtector,
  ) {}

  public async save(key: string, tokens: GoogleTokenSet): Promise<void> {
    const current = await this.readAll();
    current[key] = tokens;
    await mkdir(dirname(this.filename), { recursive: true });
    const protectedBytes = await this.protector.protect(
      Buffer.from(JSON.stringify(current), 'utf8'),
    );
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, protectedBytes, { mode: 0o600 });
    await rename(temporary, this.filename);
  }

  public async load(key: string): Promise<GoogleTokenSet | undefined> {
    return (await this.readAll())[key];
  }

  public async delete(key: string): Promise<void> {
    const current = await this.readAll();
    if (!(key in current)) return;
    delete current[key];
    if (Object.keys(current).length === 0) {
      await rm(this.filename, { force: true });
      return;
    }
    await this.saveAll(current);
  }

  private async saveAll(tokens: Record<string, GoogleTokenSet>): Promise<void> {
    await mkdir(dirname(this.filename), { recursive: true });
    const protectedBytes = await this.protector.protect(
      Buffer.from(JSON.stringify(tokens), 'utf8'),
    );
    const temporary = `${this.filename}.${process.pid}.tmp`;
    await writeFile(temporary, protectedBytes, { mode: 0o600 });
    await rename(temporary, this.filename);
  }

  private async readAll(): Promise<Record<string, GoogleTokenSet>> {
    let protectedBytes: Buffer;
    try {
      protectedBytes = await readFile(this.filename);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw error;
    }
    const raw = await this.protector.unprotect(protectedBytes);
    const parsed: unknown = JSON.parse(raw.toString('utf8'));
    if (!isTokenMap(parsed)) throw new Error('O armazenamento de tokens Google está corrompido.');
    return parsed;
  }
}

function isTokenMap(value: unknown): value is Record<string, GoogleTokenSet> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  return Object.values(value).every(
    (tokens) =>
      typeof tokens === 'object' &&
      tokens !== null &&
      typeof (tokens as GoogleTokenSet).accessToken === 'string' &&
      Array.isArray((tokens as GoogleTokenSet).scope),
  );
}
