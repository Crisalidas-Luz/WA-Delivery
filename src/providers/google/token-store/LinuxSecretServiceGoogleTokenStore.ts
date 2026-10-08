import { spawn } from 'node:child_process';
import type { GoogleTokenSet, GoogleTokenStore } from '../GooglePeopleProvider.js';

export interface SecretToolRunner {
  run(args: string[], stdin?: string): Promise<{ stdout: string; code: number }>;
}

export class LinuxSecretServiceGoogleTokenStore implements GoogleTokenStore {
  public constructor(private readonly runner: SecretToolRunner = new SpawnSecretToolRunner()) {}

  public async save(key: string, tokens: GoogleTokenSet): Promise<void> {
    const result = await this.runner.run(
      ['store', '--label=WA-Delivery Google OAuth', 'service', 'WA-Delivery', 'account', key],
      JSON.stringify(tokens),
    );
    if (result.code !== 0) throw unavailableError();
  }

  public async load(key: string): Promise<GoogleTokenSet | undefined> {
    const result = await this.runner.run(['lookup', 'service', 'WA-Delivery', 'account', key]);
    if (result.code !== 0 || !result.stdout.trim()) return undefined;
    const parsed: unknown = JSON.parse(result.stdout);
    if (!isTokenSet(parsed)) throw new Error('O token Google salvo no Secret Service é inválido.');
    return parsed;
  }

  public async delete(key: string): Promise<void> {
    const result = await this.runner.run(['clear', 'service', 'WA-Delivery', 'account', key]);
    if (result.code !== 0 && result.code !== 1) throw unavailableError();
  }
}

export class SpawnSecretToolRunner implements SecretToolRunner {
  public run(args: string[], stdin?: string): Promise<{ stdout: string; code: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn('secret-tool', args, {
        stdio: ['pipe', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') reject(unavailableError());
        else reject(error);
      });
      child.once('close', (code) =>
        resolve({ stdout: Buffer.concat(stdout).toString('utf8'), code: code ?? 1 }),
      );
      child.stdin.end(stdin ?? '');
    });
  }
}

function isTokenSet(value: unknown): value is GoogleTokenSet {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as GoogleTokenSet).accessToken === 'string' &&
    Array.isArray((value as GoogleTokenSet).scope)
  );
}

function unavailableError(): Error {
  return new Error(
    'O cofre Secret Service não está disponível. Instale libsecret/secret-tool e desbloqueie o chaveiro da sessão.',
  );
}
