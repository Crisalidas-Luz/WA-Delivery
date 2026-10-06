import { spawn } from 'node:child_process';
import type { SecretProtector } from './ProtectedFileGoogleTokenStore.js';

const PROTECT_SCRIPT = `
$inputValue = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputValue)
$protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($protected))
`;

const UNPROTECT_SCRIPT = `
$inputValue = [Console]::In.ReadToEnd()
$bytes = [Convert]::FromBase64String($inputValue)
$plain = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
[Console]::Out.Write([Convert]::ToBase64String($plain))
`;

export class WindowsDpapiSecretProtector implements SecretProtector {
  public async protect(value: Buffer): Promise<Buffer> {
    return runDpapi(PROTECT_SCRIPT, value);
  }

  public async unprotect(value: Buffer): Promise<Buffer> {
    return runDpapi(UNPROTECT_SCRIPT, value);
  }
}

async function runDpapi(script: string, value: Buffer): Promise<Buffer> {
  if (process.platform !== 'win32') {
    throw new Error('DPAPI está disponível somente no Windows.');
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Falha ao acessar o cofre seguro do Windows (${code ?? 'sem código'}).`));
        return;
      }
      try {
        resolve(Buffer.from(Buffer.concat(stdout).toString('utf8').trim(), 'base64'));
      } catch {
        reject(new Error('O cofre seguro do Windows retornou uma resposta inválida.'));
      }
    });
    child.stdin.end(value.toString('base64'));
  });
}
