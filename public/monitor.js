import { sounds } from '/sounds.js';

const errorPanel = document.querySelector('#monitor-error');
const emptyPanel = document.querySelector('#monitor-empty');
const activePanel = document.querySelector('#monitor-active');
const nameEl = document.querySelector('#monitor-name');
const statusEl = document.querySelector('#monitor-status');
const openLink = document.querySelector('#monitor-open');
const sourceEl = document.querySelector('#monitor-source');
const resumeNotice = document.querySelector('#monitor-resume-notice');
const monitorActions = document.querySelector('#monitor-actions');
const resumeButton = document.querySelector('#monitor-resume');
const metricsEl = document.querySelector('#monitor-metrics');
const progressEl = document.querySelector('#monitor-progress');
const barFill = document.querySelector('#monitor-bar-fill');
const percentEl = document.querySelector('#monitor-percent');
const factStart = document.querySelector('#fact-start');
const factElapsed = document.querySelector('#fact-elapsed');
const factRemaining = document.querySelector('#fact-remaining');
const factTotal = document.querySelector('#fact-total');
const factInterval = document.querySelector('#fact-interval');
const factBatch = document.querySelector('#fact-batch');
const factBatchWait = document.querySelector('#fact-batch-wait');
const factSource = document.querySelector('#fact-source');

const STATUS_LABELS = {
  ready: 'Pronta para envio',
  running: 'Em execução',
  paused: 'Pausada',
  completed: 'Concluída',
  cancelled: 'Cancelada',
  failed: 'Com falha',
};

let campaign;
let lastStatus;
let elapsedTimer;
// Últimos contadores conhecidos, para tocar um som por mensagem enviada/falhada.
let lastSent;
let lastFailed;
let lastProgress;

function showError(text = '') {
  errorPanel.hidden = !text;
  errorPanel.textContent = text;
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.message || 'Falha na solicitação.');
  return body;
}

function formatDuration(totalSeconds) {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '—';
  const s = Math.floor(totalSeconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h && `${h}h`, m && `${m}min`, `${sec}s`].filter(Boolean).join(' ');
}

function formatDateTime(value) {
  if (!value) return '—';
  const date = parseStoredDate(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('pt-BR');
}

function parseStoredDate(value) {
  return new Date(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : `${value.replace(' ', 'T')}Z`);
}

function startedAtMs() {
  if (!campaign?.startedAt) return undefined;
  const date = parseStoredDate(campaign.startedAt);
  return Number.isNaN(date.getTime()) ? undefined : date.getTime();
}

function renderProgress(progress) {
  lastProgress = progress;
  const done = progress.sent + progress.failed + progress.skipped;
  const percent = progress.total > 0 ? Math.round((done / progress.total) * 100) : 0;
  barFill.style.width = `${percent}%`;
  percentEl.textContent = `${percent}%`;
  progressEl.setAttribute('aria-valuenow', String(percent));
  progressEl.setAttribute('aria-valuetext', `${percent}% concluído; ${done} de ${progress.total}`);

  metricsEl.replaceChildren();
  for (const [label, value] of [
    ['Total', progress.total],
    ['Pendentes', progress.pending],
    ['Envios aceitos', progress.sent],
    ['Falhas', progress.failed],
    ['Ignorados', progress.skipped],
  ]) {
    const metric = document.createElement('div');
    metric.className = 'metric';
    const caption = document.createElement('span');
    caption.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    metric.append(caption, strong);
    metricsEl.append(metric);
  }
  statusEl.textContent = `Status: ${STATUS_LABELS[progress.status] || progress.status}.`;
  const paused = progress.status === 'paused';
  resumeNotice.hidden = !paused;
  monitorActions.hidden = !paused;
  if (paused) {
    const wait = progress.batchWaitRemainingSeconds;
    resumeNotice.textContent = progress.waitingForNextBatch
      ? `Execução interrompida com ${formatDuration(wait)} de espera entre lotes preservada. Confirme a retomada para continuar.`
      : 'Execução pausada na posição salva. Nenhum envio será retomado sem sua confirmação.';
  }
  factBatch.textContent =
    progress.totalBatches > 0 ? `${progress.currentBatchNumber} de ${progress.totalBatches}` : '—';
  renderBatchWait(progress);

  // Estimativa de tempo restante: considera cada pendente (incluindo o envio em
  // andamento) e adiciona uma folga de retentativas proporcional à taxa de
  // falhas transitórias observada, mais o backoff médio configurado.
  if (campaign) {
    const avgInterval = (campaign.delayMinSeconds + campaign.delayMaxSeconds) / 2;
    const processed = progress.sent + progress.failed + progress.skipped;
    // Taxa de falhas observada (limitada a 50%) para estimar retentativas extras.
    const failureRate = processed > 0 ? Math.min(0.5, progress.failed / processed) : 0;
    const pending = progress.pending;
    // Cada pendente incorre em um intervalo; as retentativas adicionam um
    // intervalo extra proporcional à taxa de falhas observada.
    const baseSeconds = pending * avgInterval;
    const retrySeconds = pending * failureRate * avgInterval;
    factRemaining.textContent =
      progress.status === 'running' ? formatDuration(baseSeconds + retrySeconds) : '—';
  }
}

function renderBatchWait(progress) {
  if (!progress?.waitingForNextBatch) {
    factBatchWait.textContent = '—';
    return;
  }
  const remaining = progress.nextBatchAt
    ? Math.max(0, Math.ceil((parseStoredDate(progress.nextBatchAt).getTime() - Date.now()) / 1000))
    : progress.batchWaitRemainingSeconds;
  factBatchWait.textContent =
    progress.status === 'paused'
      ? `${formatDuration(remaining)} restantes (pausado)`
      : `em ${formatDuration(remaining)}`;
}

function updateElapsed() {
  const startMs = startedAtMs();
  factElapsed.textContent = startMs ? formatDuration((Date.now() - startMs) / 1000) : '—';
  renderBatchWait(lastProgress);
}

function renderCampaign(active, progress) {
  campaign = active;
  emptyPanel.hidden = true;
  activePanel.hidden = false;
  nameEl.textContent = active.name;
  openLink.setAttribute('href', `/campaign.html?id=${active.id}`);
  factStart.textContent = formatDateTime(active.startedAt);
  factTotal.textContent = String(progress.total);
  factInterval.textContent = `${active.delayMinSeconds}s – ${active.delayMaxSeconds}s`;
  if (active.sourceCampaignId) {
    sourceEl.hidden = false;
    sourceEl.innerHTML = '';
    const link = document.createElement('a');
    link.href = `/campaign.html?id=${active.sourceCampaignId}`;
    link.textContent = `campanha #${active.sourceCampaignId}`;
    sourceEl.append('Reenvio criado a partir da ', link, '.');
    factSource.replaceChildren(link.cloneNode(true));
  } else {
    sourceEl.hidden = true;
    factSource.textContent = '—';
  }
  renderProgress(progress);
  updateElapsed();
  if (!elapsedTimer) elapsedTimer = setInterval(updateElapsed, 1000);
}

function showEmpty() {
  campaign = undefined;
  lastSent = undefined;
  lastFailed = undefined;
  activePanel.hidden = true;
  emptyPanel.hidden = false;
  if (elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  }
}

function handleStatusTransition(status, progress) {
  if (status === lastStatus) return;
  // Sons nas transições de estado.
  if (status === 'running' && lastStatus && lastStatus !== 'running') sounds.start();
  if (status === 'completed') sounds.finish();
  if (status === 'failed' || status === 'cancelled') sounds.error();
  lastStatus = status;
}

// Toca um som a cada nova mensagem enviada ou falhada durante a execução,
// comparando os contadores com o último progresso conhecido.
function handleMessageSounds(progress) {
  if (Number.isInteger(lastSent) && progress.sent > lastSent) sounds.sent();
  if (Number.isInteger(lastFailed) && progress.failed > lastFailed) sounds.error();
  lastSent = progress.sent;
  lastFailed = progress.failed;
}

async function findActive() {
  const { items } = await request('/api/campaigns');
  // Campanha ativa: em execução ou pausada (prioriza a em execução).
  return items.find((c) => c.status === 'running') ?? items.find((c) => c.status === 'paused');
}

async function load() {
  try {
    const active = await findActive();
    if (!active) {
      showEmpty();
      return;
    }
    const progress = await request(`/api/campaigns/${active.id}/progress`);
    lastStatus = progress.status;
    // Ancorar os contadores no estado atual evita tocar um som para cada
    // mensagem já enviada ao abrir/recarregar a página no meio da campanha.
    lastSent = progress.sent;
    lastFailed = progress.failed;
    renderCampaign(active, progress);
  } catch (error) {
    showError(error.message);
  }
}

const events = new EventSource('/api/events');
events.addEventListener('campaign-progress', (event) => {
  const progress = JSON.parse(event.data);
  if (!campaign || progress.campaignId !== campaign.id) {
    // Uma nova campanha entrou em execução: recarrega os detalhes.
    void load();
    return;
  }
  handleStatusTransition(progress.status, progress);
  handleMessageSounds(progress);
  renderProgress(progress);
  if (['completed', 'cancelled', 'failed'].includes(progress.status) && elapsedTimer) {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  }
});

resumeButton.addEventListener('click', async () => {
  if (!campaign) return;
  if (
    !confirm(
      'Retomar esta campanha a partir da posição salva? Os destinatários pendentes voltarão a ser processados.',
    )
  )
    return;
  resumeButton.disabled = true;
  showError();
  try {
    const progress = await request(`/api/campaigns/${campaign.id}/resume`, { method: 'POST' });
    renderProgress(progress);
  } catch (error) {
    showError(error.message);
  } finally {
    resumeButton.disabled = false;
  }
});

void load();
