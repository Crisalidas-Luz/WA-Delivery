const form = document.querySelector('#settings-form');
const errorBox = document.querySelector('#settings-error');
const successBox = document.querySelector('#settings-success');
const saveButton = document.querySelector('#save-button');

const NUMERIC_FIELDS = [
  'operationTimeoutMs',
  'retryBackoffMs',
  'retryBackoffCapMs',
  'retentionDays',
];
const TEXT_FIELDS = ['defaultCountryCode', 'defaultAreaCode'];

function fill(settings) {
  for (const field of [...TEXT_FIELDS, ...NUMERIC_FIELDS]) {
    const input = document.querySelector(`#${field}`);
    if (input) input.value = settings[field];
  }
  const sound = document.querySelector('#soundEnabled');
  document.querySelector('#maxAttempts').value = 3;
  if (sound) sound.checked = Boolean(settings.soundEnabled);
}

function collect() {
  const payload = {};
  for (const field of TEXT_FIELDS) {
    payload[field] = document.querySelector(`#${field}`).value.trim();
  }
  for (const field of NUMERIC_FIELDS) {
    payload[field] = Number(document.querySelector(`#${field}`).value);
  }
  payload.soundEnabled = document.querySelector('#soundEnabled').checked;
  return payload;
}

function showError(message) {
  errorBox.textContent = message;
  errorBox.hidden = false;
  successBox.hidden = true;
}

function showSuccess() {
  successBox.hidden = false;
  errorBox.hidden = true;
}

async function load() {
  try {
    const response = await fetch('/api/settings');
    if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
    fill(await response.json());
  } catch (error) {
    showError(`Não foi possível carregar as configurações: ${error.message}`);
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  saveButton.disabled = true;
  errorBox.hidden = true;
  successBox.hidden = true;
  try {
    const response = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collect()),
    });
    if (response.status === 422) {
      const body = await response.json();
      const details = (body.issues ?? []).map((issue) => issue.message).join(' ');
      showError(details || body.message || 'Configurações inválidas.');
      return;
    }
    if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
    fill(await response.json());
    showSuccess();
  } catch (error) {
    showError(`Não foi possível salvar as configurações: ${error.message}`);
  } finally {
    saveButton.disabled = false;
  }
});

void load();

const googleStatus = document.querySelector('#google-status');
const googleDescription = document.querySelector('#google-description');
const googleAccount = document.querySelector('#google-account');
const googleSyncStatus = document.querySelector('#google-sync-status');
const googleError = document.querySelector('#google-error');
const googleSuccess = document.querySelector('#google-success');
const googleConnect = document.querySelector('#google-connect');
const googleSync = document.querySelector('#google-sync');
const googleDisconnect = document.querySelector('#google-disconnect');
const googleCard = document.querySelector('#google-contacts-card');
const googleCredentialsForm = document.querySelector('#google-credentials-form');
const googleClientId = document.querySelector('#google-client-id');
const googleClientSecret = document.querySelector('#google-client-secret');
const googleCredentialsSave = document.querySelector('#google-credentials-save');
const googleCredentialsDelete = document.querySelector('#google-credentials-delete');
const googleConfigInfo = document.querySelector('#google-config-info');
let googleStatusPollTimer;

function showGoogleError(message = '') {
  googleError.textContent = message;
  googleError.hidden = !message;
  googleSuccess.hidden = true;
}

async function loadGoogleStatus() {
  clearTimeout(googleStatusPollTimer);
  googleCard.setAttribute('aria-busy', 'true');
  try {
    const response = await fetch('/api/google/status');
    if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
    const state = await response.json();
    googleCard.setAttribute('aria-busy', 'false');
    googleStatus.textContent = !state.configured
      ? 'Não configurado'
      : state.connected
        ? 'Conectado'
        : 'Desconectado';
    googleStatus.className = `status-badge ${state.connected ? 'status-sent' : 'status-pending'}`;
    googleDescription.textContent = state.configured
      ? 'A agenda Google é sincronizada para o banco local antes da seleção de campanhas.'
      : 'Salve as credenciais OAuth nesta tela e reinicie a aplicação para ativar a conexão.';
    googleConnect.hidden = !state.configured || state.connected;
    googleSync.hidden = !state.connected;
    googleDisconnect.hidden = !state.connected;
    googleAccount.hidden = !state.account;
    if (state.account) {
      googleAccount.textContent = `${state.account.displayName} — ${state.account.email}`;
    }
    googleSyncStatus.hidden = !state.connected;
    if (state.connected) {
      const latestAt = state.sync.lastIncrementalSyncAt || state.sync.lastFullSyncAt;
      const details =
        state.sync.status === 'running'
          ? ` Progresso atual: ${state.sync.created} novo(s), ${state.sync.updated} atualizado(s), ${state.sync.deleted} removido(s).`
          : latestAt
            ? ` Última conclusão: ${new Date(`${latestAt}Z`).toLocaleString()}. ${state.sync.created} novo(s), ${state.sync.updated} atualizado(s), ${state.sync.deleted} removido(s).`
            : '';
      const failure = state.sync.error ? ` ${state.sync.error.message}` : '';
      googleSyncStatus.textContent = `Sincronização: ${state.sync.status}${state.sync.type ? ` (${state.sync.type})` : ''}.${details}${failure}`;
      googleSync.disabled = state.sync.status === 'running';
      googleCard.setAttribute('aria-busy', String(state.sync.status === 'running'));
      if (state.sync.status === 'running') {
        googleStatusPollTimer = setTimeout(() => void loadGoogleStatus(), 1000);
      }
      if (state.sync.status === 'completed' && latestAt) {
        googleSuccess.textContent = `Sincronização concluída: ${state.sync.created} novo(s), ${state.sync.updated} atualizado(s) e ${state.sync.deleted} removido(s).`;
        googleSuccess.hidden = false;
      }
    }
  } catch (error) {
    googleCard.setAttribute('aria-busy', 'false');
    showGoogleError(`Não foi possível consultar o Google Contacts: ${error.message}`);
  }
}

async function loadGoogleConfig() {
  const response = await fetch('/api/google/config');
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || `Falha HTTP ${response.status}`);
  googleClientId.value = body.clientId || '';
  googleClientSecret.value = '';
  const environment = body.source === 'environment';
  googleClientId.disabled = environment;
  googleClientSecret.disabled = environment;
  googleCredentialsSave.hidden = environment;
  googleCredentialsDelete.hidden = !body.configured || environment;
  googleConfigInfo.textContent = environment
    ? 'Credenciais fornecidas por variáveis de ambiente. Para alterá-las, reinicie sem essas variáveis.'
    : body.configured
      ? 'Credenciais locais salvas. Para trocar o segredo, informe-o novamente. Alterações entram em vigor após reiniciar o WA-Delivery.'
      : body.secureStorageAvailable
        ? 'Nenhuma credencial salva neste computador.'
        : 'O cofre seguro do sistema operacional não está disponível.';
}

googleCredentialsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  googleCredentialsSave.disabled = true;
  showGoogleError();
  try {
    const response = await fetch('/api/google/config', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId: googleClientId.value.trim(),
        clientSecret: googleClientSecret.value.trim(),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `Falha HTTP ${response.status}`);
    googleSuccess.textContent =
      'Credenciais salvas com segurança. Reinicie o WA-Delivery para habilitar o botão de conexão.';
    googleSuccess.hidden = false;
    await loadGoogleConfig();
  } catch (error) {
    showGoogleError(`Não foi possível salvar as credenciais: ${error.message}`);
  } finally {
    googleCredentialsSave.disabled = false;
  }
});

googleCredentialsDelete.addEventListener('click', async () => {
  if (!confirm('Apagar as credenciais OAuth salvas neste computador?')) return;
  googleCredentialsDelete.disabled = true;
  showGoogleError();
  try {
    const response = await fetch('/api/google/config', { method: 'DELETE' });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.message || `Falha HTTP ${response.status}`);
    }
    googleSuccess.textContent = 'Credenciais apagadas. Reinicie o WA-Delivery para concluir.';
    googleSuccess.hidden = false;
    await loadGoogleConfig();
  } catch (error) {
    showGoogleError(`Não foi possível apagar as credenciais: ${error.message}`);
  } finally {
    googleCredentialsDelete.disabled = false;
  }
});

googleConnect.addEventListener('click', async () => {
  googleConnect.disabled = true;
  showGoogleError();
  try {
    const response = await fetch('/api/google/oauth/start', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `Falha HTTP ${response.status}`);
    location.href = body.authorizationUrl;
  } catch (error) {
    showGoogleError(`Não foi possível iniciar o login Google: ${error.message}`);
    googleConnect.disabled = false;
  }
});

googleSync.addEventListener('click', async () => {
  googleSync.disabled = true;
  showGoogleError();
  googleSuccess.hidden = true;
  try {
    const response = await fetch('/api/google/sync', { method: 'POST' });
    const body = await response.json();
    if (!response.ok) throw new Error(body.message || `Falha HTTP ${response.status}`);
    googleSuccess.textContent =
      'Sincronização iniciada. O progresso continuará mesmo após recarregar esta página.';
    googleSuccess.hidden = false;
    await loadGoogleStatus();
  } catch (error) {
    showGoogleError(`Não foi possível sincronizar: ${error.message}`);
    googleSync.disabled = false;
  }
});

googleDisconnect.addEventListener('click', async () => {
  if (
    !confirm(
      'Desconectar a conta Google deste computador? Os contatos já sincronizados permanecerão no histórico local.',
    )
  )
    return;
  googleDisconnect.disabled = true;
  showGoogleError();
  try {
    const response = await fetch('/api/google/disconnect', { method: 'POST' });
    if (!response.ok) {
      const body = await response.json();
      throw new Error(body.message || `Falha HTTP ${response.status}`);
    }
    await loadGoogleStatus();
  } catch (error) {
    showGoogleError(`Não foi possível desconectar: ${error.message}`);
  } finally {
    googleDisconnect.disabled = false;
  }
});

if (new URLSearchParams(location.search).get('google') === 'connected') {
  googleSuccess.textContent = 'Conta Google conectada. A sincronização inicial foi iniciada.';
  googleSuccess.hidden = false;
  history.replaceState({}, '', '/settings.html');
}

void Promise.all([loadGoogleConfig(), loadGoogleStatus()]).catch((error) => {
  showGoogleError(`Não foi possível carregar a configuração Google: ${error.message}`);
});

const cleanupButton = document.querySelector('#cleanup-button');
const cleanupMessage = document.querySelector('#cleanup-message');
const cleanupError = document.querySelector('#cleanup-error');

cleanupButton.addEventListener('click', async () => {
  if (
    !confirm(
      'Remover definitivamente as campanhas finalizadas mais antigas que a retenção configurada? Esta ação não pode ser desfeita.',
    )
  ) {
    return;
  }
  cleanupButton.disabled = true;
  cleanupMessage.hidden = true;
  cleanupError.hidden = true;
  try {
    const response = await fetch('/api/campaigns/cleanup', { method: 'POST' });
    const body = await response.json();
    if (response.status === 422) {
      cleanupError.textContent = body.message || 'Retenção desativada.';
      cleanupError.hidden = false;
      return;
    }
    if (!response.ok) throw new Error(`Falha HTTP ${response.status}`);
    cleanupMessage.textContent = `${body.removed} campanha(s) removida(s) (retenção de ${body.retentionDays} dias).`;
    cleanupMessage.hidden = false;
  } catch (error) {
    cleanupError.textContent = `Não foi possível executar a limpeza: ${error.message}`;
    cleanupError.hidden = false;
  } finally {
    cleanupButton.disabled = false;
  }
});

const restoreForm = document.querySelector('#restore-form');
const restoreFile = document.querySelector('#restore-file');
const restoreButton = document.querySelector('#restore-button');
const restoreMessage = document.querySelector('#restore-message');
const restoreError = document.querySelector('#restore-error');

restoreForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = restoreFile.files[0];
  if (!file) return;
  if (
    !confirm(
      'Restaurar substitui os dados atuais (banco, mídias e sessão do WhatsApp). Um backup de segurança será criado antes. Continuar?',
    )
  ) {
    return;
  }
  restoreButton.disabled = true;
  restoreMessage.hidden = true;
  restoreError.hidden = true;
  try {
    const body = new FormData();
    body.append('file', file);
    const response = await fetch('/api/backup/restore', { method: 'POST', body });
    const data = await response.json();
    if (!response.ok) {
      restoreError.textContent = data.message || 'Falha ao restaurar o backup.';
      restoreError.hidden = false;
      return;
    }
    restoreMessage.textContent = data.message || 'Backup restaurado. A aplicação será reiniciada.';
    restoreMessage.hidden = false;
  } catch (error) {
    restoreError.textContent = `Não foi possível restaurar: ${error.message}`;
    restoreError.hidden = false;
  } finally {
    restoreButton.disabled = false;
  }
});
