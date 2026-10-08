import { sounds } from '/sounds.js';

const title = document.querySelector('#campaign-title');
const statusText = document.querySelector('#campaign-status');
const details = document.querySelector('#campaign-details');
const form = document.querySelector('#campaign-form');
const campaignName = document.querySelector('#campaign-name');
const contactList = document.querySelector('#campaign-list');
const contactListLabel = document.querySelector('#campaign-list-label');
const followUpSelectionNote = document.querySelector('#follow-up-selection-note');
const googleSelectionPanel = document.querySelector('#campaign-google-selection');
const googleSelectionSummary = document.querySelector('#campaign-google-selection-summary');
const messageTemplate = document.querySelector('#message-template');
const messageCounter = document.querySelector('#message-counter');
const delayMin = document.querySelector('#delay-min');
const delayMax = document.querySelector('#delay-max');
const batchSize = document.querySelector('#batch-size');
const batchIntervalHours = document.querySelector('#batch-interval-hours');
const batchIntervalMinutes = document.querySelector('#batch-interval-minutes');
const batchOrder = document.querySelector('#batch-order');
const insertName = document.querySelector('#insert-name');
const mediaInput = document.querySelector('#campaign-media-input');
const mediaPanel = document.querySelector('#campaign-media');
const mediaContent = document.querySelector('#campaign-media-content');
const removeMedia = document.querySelector('#remove-media');
const saveButton = document.querySelector('#save-campaign');
const deleteButton = document.querySelector('#delete-campaign');
const actionsBar = document.querySelector('#campaign-actions');
const prepareZone = document.querySelector('#prepare-zone');
const prepareConfirmation = document.querySelector('#prepare-confirmation');
const prepareButton = document.querySelector('#prepare-campaign');
const recipientReview = document.querySelector('#recipient-review');
const recipientSummary = document.querySelector('#recipient-summary');
const recipientList = document.querySelector('#recipient-list');
const recipientFilter = document.querySelector('#recipient-filter');
const exportAll = document.querySelector('#export-all');
const exportFailures = document.querySelector('#export-failures');
const previousManifestPage = document.querySelector('#previous-manifest-page');
const nextManifestPage = document.querySelector('#next-manifest-page');
const manifestPageLabel = document.querySelector('#manifest-page-label');
const executionZone = document.querySelector('#execution-zone');
const executionMetrics = document.querySelector('#execution-metrics');
const startConfirmationLabel = document.querySelector('#start-confirmation-label');
const startConfirmation = document.querySelector('#start-confirmation');
const startCampaign = document.querySelector('#start-campaign');
const pauseCampaign = document.querySelector('#pause-campaign');
const resumeCampaign = document.querySelector('#resume-campaign');
const cancelCampaign = document.querySelector('#cancel-campaign');
const executionNotice = document.querySelector('#execution-notice');
const followUpZone = document.querySelector('#follow-up-zone');
const followUpButton = document.querySelector('#follow-up-campaign');
const sourceLink = document.querySelector('#source-link');
const contactDeletionZone = document.querySelector('#contact-deletion-zone');
const contactDeletionSummary = document.querySelector('#contact-deletion-summary');
const contactDeletionConfirmation = document.querySelector('#contact-deletion-confirmation');
const deleteGoogleContacts = document.querySelector('#delete-google-contacts');
const retryGoogleDeletions = document.querySelector('#retry-google-deletions');
const contactDeletionResults = document.querySelector('#contact-deletion-results');
const errorPanel = document.querySelector('#campaign-error');
const campaignId = Number(new URLSearchParams(location.search).get('id'));
let selectedMedia;
let loadedCampaign;
let campaignIsTerminal = false;
let currentDeletionJob;
let deletionPollTimer;
const selectedForDeletion = new Set();

function showError(text = '') {
  errorPanel.hidden = !text;
  errorPanel.textContent = text;
}

async function request(path, options = {}) {
  const response = await fetch(path, options);
  const body = response.status === 204 ? undefined : await response.json();
  if (!response.ok) {
    throw new Error(
      body?.issues?.map((issue) => issue.message).join(' ') ||
        body?.message ||
        'Falha na solicitação.',
    );
  }
  return body;
}

function renderMedia() {
  mediaPanel.hidden = !selectedMedia;
  if (!selectedMedia) {
    mediaContent.replaceChildren();
    return;
  }
  const preview = document.createElement(selectedMedia.kind === 'video' ? 'video' : 'img');
  preview.src = `/api/media/${selectedMedia.id}`;
  preview.alt = selectedMedia.originalName;
  if (selectedMedia.kind === 'video') preview.controls = true;
  const caption = document.createElement('span');
  caption.textContent = `${selectedMedia.originalName} (${(selectedMedia.sizeBytes / 1024 / 1024).toFixed(2)} MB)`;
  mediaContent.replaceChildren(preview, caption);
}

const RECIPIENT_STATUS_LABELS = {
  pending: 'Pendente',
  sending: 'Enviando',
  sent: 'Envio aceito',
  failed: 'Falha',
  skipped: 'Ignorado',
};
let allRecipients = [];
let manifestSummary;
let manifestPage = 1;
const manifestPageSize = 50;

function renderRecipients(recipients, summary) {
  allRecipients = recipients;
  if (summary) manifestSummary = summary;
  paintRecipients();
  recipientReview.hidden = false;
}

function paintRecipients() {
  const filter = recipientFilter?.value || '';
  const [filterKind, filterValue] = filter.split(':');
  const filtered = filter
    ? allRecipients.filter((recipient) => {
        if (filterKind === 'status') return recipient.status === filterValue;
        if (filterKind === 'eligibility') return recipient.eligibilityStatus === filterValue;
        if (filterKind === 'recommendation')
          return recipient.deletionRecommendation === filterValue;
        return recipient.status === filter;
      })
    : allRecipients;
  const totalPages = Math.max(1, Math.ceil(filtered.length / manifestPageSize));
  manifestPage = Math.min(manifestPage, totalPages);
  const pageItems = filtered.slice(
    (manifestPage - 1) * manifestPageSize,
    manifestPage * manifestPageSize,
  );
  recipientSummary.textContent = manifestSummary
    ? `${manifestSummary.selected} selecionados; ${manifestSummary.accepted} envios aceitos; ${manifestSummary.permanentFailures} falhas permanentes; ${manifestSummary.transientFailuresExhausted} falhas transitórias esgotadas; ${manifestSummary.recommendedForDeletion} recomendados para revisão de exclusão. Exibindo ${filtered.length}.`
    : `${allRecipients.length} destinatário(s) nesta campanha (lista fixada no preparo). Exibindo ${filtered.length}.`;
  recipientList.replaceChildren();
  for (const recipient of pageItems) {
    const article = document.createElement('article');
    article.className = 'message-sample';
    const heading = document.createElement('div');
    const name = document.createElement('strong');
    name.textContent = recipient.name;
    const phone = document.createElement('span');
    phone.textContent = recipient.phone ?? recipient.phoneOriginal ?? 'Sem telefone';
    heading.append(name, phone);

    if (campaignIsTerminal && canDeleteFromGoogle(recipient)) {
      const selection = document.createElement('label');
      selection.className = 'recipient-delete-selection';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = selectedForDeletion.has(recipient.id);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedForDeletion.add(recipient.id);
        else selectedForDeletion.delete(recipient.id);
        updateDeletionControls();
      });
      const text = document.createElement('span');
      text.textContent = 'Selecionar para excluir do Google';
      selection.append(checkbox, text);
      heading.prepend(selection);
    }

    const meta = document.createElement('div');
    meta.className = 'recipient-meta';
    const badge = document.createElement('span');
    badge.className = `status-badge status-${recipient.status}`;
    badge.textContent = RECIPIENT_STATUS_LABELS[recipient.status] ?? recipient.status;
    meta.append(badge);
    const batch = document.createElement('span');
    batch.className = 'recipient-attempts';
    batch.textContent = `Lote ${recipient.batchNumber}`;
    meta.append(batch);
    if (recipient.attemptCount) {
      const attempts = document.createElement('span');
      attempts.className = 'recipient-attempts';
      attempts.textContent = `${recipient.attemptCount} tentativa(s)`;
      meta.append(attempts);
    }

    const renderedMessage = document.createElement('p');
    renderedMessage.className = 'message-body';
    renderedMessage.textContent = recipient.renderedMessage;
    article.append(heading, meta, renderedMessage);
    if (recipient.lastError) {
      const error = document.createElement('p');
      error.className = 'recipient-error';
      error.textContent = recipient.lastError;
      article.append(error);
    }
    if (recipient.resultReason) {
      const reason = document.createElement('p');
      reason.className = 'recipient-error';
      reason.textContent = recipient.resultReason;
      article.append(reason);
    }
    recipientList.append(article);
  }
  manifestPageLabel.textContent = `Página ${manifestPage} de ${totalPages}`;
  previousManifestPage.disabled = manifestPage <= 1;
  nextManifestPage.disabled = manifestPage >= totalPages;
}

function canDeleteFromGoogle(recipient) {
  const reason = recipient.deletionReasonCode || recipient.eligibilityStatus;
  return (
    recipient.googleContactId &&
    recipient.resourceName &&
    recipient.deletionRecommendation !== 'not_recommended' &&
    ['missing_phone', 'invalid_phone', 'not_on_whatsapp'].includes(reason)
  );
}

function updateDeletionControls() {
  if (!contactDeletionZone) return;
  contactDeletionZone.hidden = !campaignIsTerminal || !allRecipients.some(canDeleteFromGoogle);
  const selected = allRecipients.filter((recipient) => selectedForDeletion.has(recipient.id));
  const groups = selected.reduce((result, recipient) => {
    const reason = recipient.deletionReasonCode || recipient.eligibilityStatus;
    result[reason] = (result[reason] || 0) + 1;
    return result;
  }, {});
  const reasonLabels = {
    missing_phone: 'sem telefone',
    invalid_phone: 'telefone inválido',
    not_on_whatsapp: 'fora do WhatsApp',
  };
  const detail = Object.entries(groups)
    .map(([reason, count]) => `${count} ${reasonLabels[reason] || reason}`)
    .join('; ');
  contactDeletionSummary.textContent = selected.length
    ? `${selected.length} contato(s) selecionado(s): ${detail}. A evidência será validada novamente antes de cada exclusão.`
    : 'Nenhum contato selecionado para exclusão.';
  deleteGoogleContacts.disabled = selected.length === 0 || !contactDeletionConfirmation.checked;
}

function renderDeletionJob(job) {
  currentDeletionJob = job;
  selectedForDeletion.clear();
  contactDeletionConfirmation.checked = false;
  contactDeletionResults.replaceChildren();
  const statusLabels = {
    deleted: 'Exclusão aceita pelo Google',
    already_missing: 'Contato já não existia',
    failed: 'Falha — nenhuma exclusão realizada neste item',
    cancelled: 'Cancelado',
    pending: 'Pendente',
    deleting: 'Excluindo',
  };
  for (const item of job.items) {
    const article = document.createElement('article');
    article.className = 'message-sample';
    const heading = document.createElement('strong');
    heading.textContent = item.displayName || item.resourceName;
    const status = document.createElement('p');
    status.textContent = `${statusLabels[item.status] || item.status}${item.verifiedAt ? ' — confirmado por sincronização' : item.status === 'deleted' ? ' — aguardando confirmação da sincronização' : ''}`;
    article.append(heading, status);
    if (item.lastErrorMessage) {
      const error = document.createElement('p');
      error.className = 'recipient-error';
      error.textContent = item.lastErrorMessage;
      article.append(error);
    }
    contactDeletionResults.append(article);
  }
  const canResume =
    job.status !== 'running' &&
    job.items.some((item) => ['failed', 'pending'].includes(item.status));
  retryGoogleDeletions.hidden = !canResume;
  retryGoogleDeletions.textContent = job.items.some((item) => item.status === 'pending')
    ? 'Retomar exclusões pendentes'
    : 'Tentar novamente as exclusões com falha';
  paintRecipients();
}

function pollDeletionJob(jobId) {
  clearTimeout(deletionPollTimer);
  deletionPollTimer = setTimeout(async () => {
    try {
      const job = await request(`/api/contact-deletion-jobs/${jobId}`);
      renderDeletionJob(job);
      if (['pending', 'running'].includes(job.status)) pollDeletionJob(job.id);
    } catch (error) {
      showError(error.message);
    }
  }, 1000);
}

async function loadLatestDeletionJob() {
  const response = await fetch(`/api/campaigns/${campaignId}/deletion-jobs/latest`);
  if (response.status === 404 || response.status === 503) return;
  const job = await response.json();
  if (!response.ok) throw new Error(job.message || 'Não foi possível carregar a auditoria.');
  renderDeletionJob(job);
  if (['pending', 'running'].includes(job.status)) pollDeletionJob(job.id);
}

function applyLockedState(campaign, recipients, summary) {
  for (const control of form.elements) control.disabled = true;
  // Fora de rascunho não há edição: esconde "Salvar"; "Excluir" some só em execução.
  saveButton.hidden = true;
  deleteButton.hidden = campaign.status === 'running';
  actionsBar.hidden = campaign.status === 'running';
  prepareZone.hidden = true;
  renderRecipients(recipients, summary);
  executionZone.hidden = false;
}

function renderProgress(progress) {
  const labels = {
    ready: 'pronta para envio',
    running: 'em execução',
    paused: 'pausada',
    completed: 'concluída',
    cancelled: 'cancelada',
    failed: 'com falha',
  };
  statusText.textContent = `Status: ${labels[progress.status] || progress.status}.`;
  executionMetrics.replaceChildren();
  for (const [label, value] of [
    ['Total', progress.total],
    ['Pendentes', progress.pending],
    ['Envios aceitos', progress.sent],
    ['Falhas', progress.failed],
    ['Ignorados', progress.skipped],
    [
      'Lote',
      progress.totalBatches > 0 ? `${progress.currentBatchNumber}/${progress.totalBatches}` : '—',
    ],
  ]) {
    const metric = document.createElement('div');
    metric.className = 'metric';
    const caption = document.createElement('span');
    caption.textContent = label;
    const strong = document.createElement('strong');
    strong.textContent = String(value);
    metric.append(caption, strong);
    executionMetrics.append(metric);
  }
  const ready = progress.status === 'ready';
  const running = progress.status === 'running';
  const terminal = ['completed', 'cancelled', 'failed'].includes(progress.status);
  campaignIsTerminal = terminal;
  updateDeletionControls();
  if (terminal && !currentDeletionJob)
    void loadLatestDeletionJob().catch((error) => showError(error.message));
  // O checkbox de confirmação só aparece quando a campanha está pronta e ainda
  // não iniciou. Ao iniciar, ele some e o estado fica claro.
  startConfirmationLabel.hidden = !ready;
  startCampaign.hidden = !ready;
  pauseCampaign.hidden = !running;
  resumeCampaign.hidden = progress.status !== 'paused';
  cancelCampaign.hidden = !['ready', 'running', 'paused'].includes(progress.status);
  if (executionNotice) {
    executionNotice.hidden = !running && !progress.waitingForNextBatch;
    if (progress.waitingForNextBatch) {
      const remaining = progress.nextBatchAt
        ? Math.max(0, Math.ceil((new Date(progress.nextBatchAt).getTime() - Date.now()) / 1000))
        : progress.batchWaitRemainingSeconds;
      executionNotice.textContent =
        progress.status === 'paused'
          ? `Espera entre lotes pausada com ${remaining ?? 0}s restantes.`
          : `Aguardando o próximo lote: aproximadamente ${remaining ?? 0}s.`;
    } else {
      executionNotice.textContent = running
        ? 'Campanha em execução. Os envios estão sendo processados.'
        : '';
    }
  }
  // Reenvio dos pendentes só a partir de uma campanha finalizada.
  if (followUpZone) {
    const hasPending = progress.failed + progress.skipped > 0;
    followUpZone.hidden = !(terminal && hasPending);
  }
}

async function load() {
  if (!Number.isSafeInteger(campaignId) || campaignId <= 0)
    throw new Error('Identificador da campanha inválido.');
  const [{ items: lists }, campaign] = await Promise.all([
    request('/api/contact-lists'),
    request(`/api/campaigns/${campaignId}`),
  ]);
  contactList.innerHTML = '<option value="">Selecione uma lista</option>';
  for (const list of lists) {
    const option = document.createElement('option');
    option.value = String(list.id);
    option.textContent = `${list.name} (${list.contactCount})`;
    contactList.append(option);
  }
  title.textContent = campaign.name;
  loadedCampaign = campaign;
  campaignName.value = campaign.name;
  contactList.value = campaign.contactListId ? String(campaign.contactListId) : '';
  if (campaign.sourceCampaignId && campaign.selectionSource === 'local_list') {
    contactList.disabled = true;
    followUpSelectionNote.hidden = false;
  }
  const usesGoogle = campaign.selectionSource === 'google';
  contactListLabel.hidden = usesGoogle;
  googleSelectionPanel.hidden = !usesGoogle;
  if (usesGoogle) {
    const summary = campaign.selectionSummary ?? {};
    googleSelectionSummary.textContent = `${summary.selected ?? 0} selecionados; ${summary.eligible ?? 0} elegíveis. Os filtros e exceções estão salvos no rascunho.`;
  }
  messageTemplate.value = campaign.messageTemplate;
  messageCounter.textContent = `${campaign.messageTemplate.length} / 4096`;
  delayMin.value = String(campaign.delayMinSeconds);
  delayMax.value = String(campaign.delayMaxSeconds);
  batchSize.value = String(campaign.batchSize);
  batchIntervalHours.value = String(Math.floor(campaign.batchIntervalSeconds / 3600));
  batchIntervalMinutes.value = String(Math.floor((campaign.batchIntervalSeconds % 3600) / 60));
  batchOrder.value = campaign.batchOrder;
  selectedMedia = campaign.media;
  renderMedia();
  details.hidden = false;
  if (sourceLink) {
    if (campaign.sourceCampaignId) {
      sourceLink.hidden = false;
      sourceLink.innerHTML = '';
      const link = document.createElement('a');
      link.href = `/campaign.html?id=${campaign.sourceCampaignId}`;
      link.textContent = `campanha de origem #${campaign.sourceCampaignId}`;
      sourceLink.append('Reenvio criado a partir da ', link, '.');
    } else {
      sourceLink.hidden = true;
    }
  }
  if (campaign.status !== 'draft') {
    const [manifest, progress] = await Promise.all([
      request(`/api/campaigns/${campaignId}/manifest`),
      request(`/api/campaigns/${campaignId}/progress`),
    ]);
    applyLockedState(campaign, manifest.items, manifest.summary);
    renderProgress(progress);
  } else {
    statusText.textContent = 'Status: rascunho editável.';
  }
}

messageTemplate.addEventListener('input', () => {
  messageCounter.textContent = `${messageTemplate.value.length} / 4096`;
});

insertName.addEventListener('click', () => {
  messageTemplate.setRangeText(
    '{{nome}}',
    messageTemplate.selectionStart,
    messageTemplate.selectionEnd,
    'end',
  );
  messageTemplate.dispatchEvent(new Event('input'));
  messageTemplate.focus();
});

mediaInput.addEventListener('change', async () => {
  const file = mediaInput.files?.[0];
  if (!file) return;
  showError();
  mediaInput.disabled = true;
  try {
    const body = new FormData();
    body.append('file', file);
    selectedMedia = await request('/api/media', { method: 'POST', body });
    renderMedia();
  } catch (error) {
    mediaInput.value = '';
    showError(error.message);
  } finally {
    mediaInput.disabled = false;
  }
});

removeMedia.addEventListener('click', () => {
  selectedMedia = undefined;
  mediaInput.value = '';
  renderMedia();
});

prepareConfirmation.addEventListener('change', () => {
  prepareButton.disabled = !prepareConfirmation.checked;
});

prepareButton.addEventListener('click', async () => {
  showError();
  prepareButton.disabled = true;
  try {
    const prepared = await request(`/api/campaigns/${campaignId}/prepare`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: prepareConfirmation.checked }),
    });
    const manifest = await request(`/api/campaigns/${campaignId}/manifest`);
    applyLockedState(prepared.campaign, manifest.items, manifest.summary);
    renderProgress(await request(`/api/campaigns/${campaignId}/progress`));
  } catch (error) {
    showError(error.message);
    prepareButton.disabled = !prepareConfirmation.checked;
  }
});

startConfirmation.addEventListener('change', () => {
  startCampaign.disabled = !startConfirmation.checked;
});

async function queueAction(action, body) {
  showError();
  try {
    const progress = await request(`/api/campaigns/${campaignId}/${action}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    // Ao iniciar, leva o usuário para a página de monitoramento da execução.
    if (action === 'start') {
      sounds.start();
      location.href = '/monitor.html';
      return;
    }
    renderProgress(progress);
  } catch (error) {
    showError(error.message);
  }
}

startCampaign.addEventListener('click', () =>
  queueAction('start', { confirmed: startConfirmation.checked }),
);
pauseCampaign.addEventListener('click', () => queueAction('pause'));
resumeCampaign.addEventListener('click', () => queueAction('resume'));
cancelCampaign.addEventListener('click', () => {
  if (confirm('Cancelar esta campanha? Os destinatários pendentes não serão enviados.')) {
    void queueAction('cancel');
  }
});

const events = new EventSource('/api/events');
events.addEventListener('campaign-progress', (event) => {
  const progress = JSON.parse(event.data);
  if (progress.campaignId !== campaignId) return;
  renderProgress(progress);
  // Atualiza a lista de destinatários para refletir status/erros em tempo real.
  void request(`/api/campaigns/${campaignId}/manifest`)
    .then((manifest) => {
      if (!recipientReview.hidden) renderRecipients(manifest.items, manifest.summary);
    })
    .catch(() => {});
});

if (recipientFilter)
  recipientFilter.addEventListener('change', () => {
    manifestPage = 1;
    paintRecipients();
  });
if (previousManifestPage)
  previousManifestPage.addEventListener('click', () => {
    manifestPage -= 1;
    paintRecipients();
  });
if (nextManifestPage)
  nextManifestPage.addEventListener('click', () => {
    manifestPage += 1;
    paintRecipients();
  });
if (contactDeletionConfirmation)
  contactDeletionConfirmation.addEventListener('change', updateDeletionControls);
if (deleteGoogleContacts) {
  deleteGoogleContacts.addEventListener('click', async () => {
    const ids = [...selectedForDeletion];
    if (!ids.length || !contactDeletionConfirmation.checked) return;
    if (
      !confirm(
        `Excluir permanentemente ${ids.length} contato(s) da conta Google? A ação será auditada, mas não pode ser desfeita.`,
      )
    )
      return;
    deleteGoogleContacts.disabled = true;
    showError();
    try {
      const job = await request(`/api/campaigns/${campaignId}/deletion-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          confirmed: true,
          recipientIds: ids,
          filterSnapshot: { manifestFilter: recipientFilter?.value || '' },
        }),
      });
      renderDeletionJob(job);
      if (['pending', 'running'].includes(job.status)) pollDeletionJob(job.id);
    } catch (error) {
      showError(error.message);
      updateDeletionControls();
    }
  });
}
if (retryGoogleDeletions) {
  retryGoogleDeletions.addEventListener('click', async () => {
    if (!currentDeletionJob) return;
    retryGoogleDeletions.disabled = true;
    showError();
    try {
      renderDeletionJob(
        await request(`/api/contact-deletion-jobs/${currentDeletionJob.id}/retry`, {
          method: 'POST',
        }),
      );
      pollDeletionJob(currentDeletionJob.id);
    } catch (error) {
      showError(error.message);
    } finally {
      retryGoogleDeletions.disabled = false;
    }
  });
}
if (exportAll) exportAll.setAttribute('href', `/api/campaigns/${campaignId}/export`);
if (exportFailures)
  exportFailures.setAttribute('href', `/api/campaigns/${campaignId}/export?onlyFailures=true`);

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showError();
  saveButton.disabled = true;
  try {
    const updated = await request(`/api/campaigns/${campaignId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: campaignName.value,
        ...(loadedCampaign.selectionSource === 'google'
          ? { contactSelection: loadedCampaign.contactSelection }
          : { contactListId: Number(contactList.value) }),
        messageTemplate: messageTemplate.value,
        delayMinSeconds: Number(delayMin.value),
        delayMaxSeconds: Number(delayMax.value),
        batchSize: Number(batchSize.value),
        batchIntervalSeconds:
          Number(batchIntervalHours.value) * 3600 + Number(batchIntervalMinutes.value) * 60,
        batchOrder: batchOrder.value,
        ...(loadedCampaign.batchOrderSeed ? { batchOrderSeed: loadedCampaign.batchOrderSeed } : {}),
        mediaId: selectedMedia?.id ?? null,
      }),
    });
    selectedMedia = updated.media;
    loadedCampaign = updated;
    title.textContent = updated.name;
    renderMedia();
    mediaInput.value = '';
    saveButton.textContent = 'Alterações salvas';
    setTimeout(() => {
      saveButton.textContent = 'Salvar alterações';
    }, 1800);
  } catch (error) {
    showError(error.message);
  } finally {
    saveButton.disabled = false;
  }
});

deleteButton.addEventListener('click', async () => {
  if (
    !confirm(
      'Excluir esta campanha? Esta ação não pode ser desfeita e removerá o histórico dos envios.',
    )
  )
    return;
  deleteButton.disabled = true;
  try {
    await request(`/api/campaigns/${campaignId}`, { method: 'DELETE' });
    location.href = '/campaigns.html';
  } catch (error) {
    showError(error.message);
    deleteButton.disabled = false;
  }
});

if (followUpButton) {
  followUpButton.addEventListener('click', async () => {
    if (
      !confirm(
        'Criar uma nova campanha com apenas os destinatários pendentes (falhas e ignorados)? A campanha atual será mantida como histórico.',
      )
    )
      return;
    followUpButton.disabled = true;
    showError();
    try {
      const created = await request(`/api/campaigns/${campaignId}/follow-up`, { method: 'POST' });
      location.href = `/campaign.html?id=${created.id}`;
    } catch (error) {
      showError(error.message);
      followUpButton.disabled = false;
    }
  });
}

load().catch((error) => showError(error.message));
