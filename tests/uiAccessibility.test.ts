import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function publicFile(name: string): Promise<string> {
  return readFile(new URL(`../public/${name}`, import.meta.url), 'utf8');
}

describe('feedback acessível para operações longas', () => {
  it('expõe a sincronização Google como região viva e ocupada', async () => {
    const [html, script] = await Promise.all([
      publicFile('settings.html'),
      publicFile('settings.js'),
    ]);

    assert.match(html, /id="google-contacts-card" aria-busy="true"/);
    assert.match(html, /id="google-sync-status"[^>]+role="status"[^>]+aria-live="polite"/);
    assert.match(
      script,
      /googleCard\.setAttribute\('aria-busy', String\(state\.sync\.status === 'running'\)\)/,
    );
    assert.match(script, /Progresso atual:/);
  });

  it('expõe progresso numérico da campanha a tecnologias assistivas', async () => {
    const [html, script] = await Promise.all([
      publicFile('monitor.html'),
      publicFile('monitor.js'),
    ]);

    assert.match(html, /id="monitor-progress"[\s\S]*?role="progressbar"/);
    assert.match(html, /aria-valuemin="0"[\s\S]*?aria-valuemax="100"/);
    assert.match(script, /progressEl\.setAttribute\('aria-valuenow', String\(percent\)\)/);
  });

  it('anuncia e marca como ocupada a exclusão Google em andamento', async () => {
    const [html, script] = await Promise.all([
      publicFile('campaign.html'),
      publicFile('campaign.js'),
    ]);

    assert.match(
      html,
      /id="contact-deletion-results"[\s\S]*?role="status"[\s\S]*?aria-live="polite"[\s\S]*?aria-busy="false"/,
    );
    assert.match(
      script,
      /contactDeletionResults\.setAttribute\('aria-busy', String\(jobActive\)\)/,
    );
  });
});
