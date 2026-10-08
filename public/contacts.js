const form = document.querySelector('#manual-list-form');
const listName = document.querySelector('#list-name');
const rows = document.querySelector('#contact-rows');
const addButton = document.querySelector('#add-contact');
const errors = document.querySelector('#form-errors');
const savedLists = document.querySelector('#saved-lists');
const uploadForm = document.querySelector('#csv-upload-form');
const csvFile = document.querySelector('#csv-file');
const csvErrors = document.querySelector('#csv-errors');
const csvPreview = document.querySelector('#csv-preview');
const csvAnalysis = document.querySelector('#csv-analysis');
const fileSummary = document.querySelector('#csv-file-summary');
const phoneColumn = document.querySelector('#phone-column');
const nameColumn = document.querySelector('#name-column');
const previewTable = document.querySelector('#preview-table');
const analysisCards = document.querySelector('#analysis-cards');
const analysisTable = document.querySelector('#analysis-table');
const importListName = document.querySelector('#import-list-name');
const analyzeMapping = document.querySelector('#analyze-mapping');
const confirmImport = document.querySelector('#confirm-import');
let currentPreview;

const tabGoogle = document.querySelector('#tab-google');
const tabImport = document.querySelector('#tab-import');
const tabManual = document.querySelector('#tab-manual');
const panelGoogle = document.querySelector('#panel-google');
const panelImport = document.querySelector('#panel-import');
const panelManual = document.querySelector('#panel-manual');
let googleLoaded = false;
const editCampaignId = Number(new URLSearchParams(location.search).get('campaign'));
let editingCampaign;

function selectTab(target) {
  const showGoogle = target === 'google';
  const showImport = target === 'import';
  const showManual = target === 'manual';
  tabGoogle.classList.toggle('active', showGoogle);
  tabImport.classList.toggle('active', showImport);
  tabManual.classList.toggle('active', showManual);
  tabGoogle.setAttribute('aria-selected', String(showGoogle));
  tabImport.setAttribute('aria-selected', String(showImport));
  tabManual.setAttribute('aria-selected', String(showManual));
  panelGoogle.hidden = !showGoogle;
  panelImport.hidden = !showImport;
  panelManual.hidden = !showManual;
  if (showGoogle && !googleLoaded) void initializeGoogleContacts();
}

tabGoogle.addEventListener('click', () => selectTab('google'));
tabImport.addEventListener('click', () => selectTab('import'));
tabManual.addEventListener('click', () => selectTab('manual'));

const googleStatus = document.querySelector('#google-contact-status');
const googleError = document.querySelector('#google-contact-error');
const filterRules = document.querySelector('#filter-rules');
const savedFilter = document.querySelector('#saved-filter');
const filterName = document.querySelector('#filter-name');
const googleResults = document.querySelector('#google-contact-results');
const pageLabel = document.querySelector('#contact-page-label');
const previousPage = document.querySelector('#previous-contact-page');
const nextPage = document.querySelector('#next-contact-page');
const selectAllMatching = document.querySelector('#select-all-matching');
const selectionSummary = document.querySelector('#contact-selection-summary');
let contactPage = 1;
let contactTotal = 0;
let currentFilter;
const includedContactIds = new Set();
const excludedContactIds = new Set();
const phoneChoices = new Map();

const contactFields = {
  displayName: 'Nome exibido',
  givenName: 'Nome',
  middleName: 'Nome do meio',
  familyName: 'Sobrenome',
  nickname: 'Apelido',
  phone: 'Telefone',
  phoneLabel: 'Tipo do telefone',
  email: 'E-mail',
  address: 'Endereço',
  relation: 'Relação',
  url: 'URL',
  userDefined: 'Campo personalizado',
  organizationName: 'Organização',
  organizationTitle: 'Cargo',
  organizationDepartment: 'Departamento',
  birthday: 'Aniversário',
  biography: 'Notas/biografia',
  label: 'Label/grupo',
  source: 'Origem',
  phoneValidity: 'Validade do telefone',
  duplicateState: 'Duplicidade',
  optOut: 'Opt-out',
  remoteUpdatedAt: 'Última alteração',
};
const contactOperators = {
  contains: 'contém',
  notContains: 'não contém',
  equals: 'é igual a',
  notEquals: 'é diferente de',
  startsWith: 'começa com',
  endsWith: 'termina com',
  isEmpty: 'está vazio',
  isNotEmpty: 'não está vazio',
  before: 'antes de',
  after: 'depois de',
  between: 'entre',
  in: 'está na lista',
  notIn: 'não está na lista',
};

function objectOptions(values, selected) {
  return Object.entries(values)
    .map(
      ([value, label]) =>
        `<option value="${value}" ${value === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`,
    )
    .join('');
}

function createFilterRule(rule = { field: 'displayName', operator: 'isNotEmpty' }) {
  const row = document.createElement('div');
  row.className = 'filter-rule';
  row.dataset.filterNode = 'rule';
  row.innerHTML = `
    <label>Campo<select class="filter-field">${objectOptions(contactFields, rule.field)}</select></label>
    <label>Operador<select class="filter-operator">${objectOptions(contactOperators, rule.operator)}</select></label>
    <label>Valor<input class="filter-value" placeholder="Texto, data ou valores separados por vírgula"></label>
    <button class="danger remove-filter-rule" type="button">Remover</button>`;
  row.querySelector('.filter-value').value = Array.isArray(rule.value)
    ? rule.value.join(', ')
    : (rule.value ?? '');
  const updateValueState = () => {
    row.querySelector('.filter-value').disabled = ['isEmpty', 'isNotEmpty'].includes(
      row.querySelector('.filter-operator').value,
    );
  };
  row.querySelector('.filter-operator').addEventListener('change', updateValueState);
  row.querySelector('.remove-filter-rule').addEventListener('click', () => {
    const container = row.parentElement;
    if (container.children.length > 1) row.remove();
  });
  updateValueState();
  return row;
}

function createFilterGroup(
  group = { type: 'group', combinator: 'and', children: [] },
  isRoot = false,
) {
  const panel = document.createElement('section');
  panel.className = `filter-group${isRoot ? ' filter-group-root' : ''}`;
  panel.dataset.filterNode = 'group';
  const header = document.createElement('div');
  header.className = 'filter-group-header';
  const combinatorLabel = document.createElement('label');
  combinatorLabel.textContent = isRoot
    ? 'Combinar tudo neste filtro'
    : 'Combinar itens deste grupo';
  const combinator = document.createElement('select');
  combinator.className = 'filter-group-combinator';
  combinator.innerHTML =
    '<option value="and">Todas (E)</option><option value="or">Qualquer uma (OU)</option>';
  combinator.value = group.combinator;
  combinatorLabel.append(combinator);
  const actions = document.createElement('div');
  actions.className = 'filter-group-actions';
  const addRule = document.createElement('button');
  addRule.type = 'button';
  addRule.className = 'secondary';
  addRule.textContent = 'Adicionar regra';
  const addGroup = document.createElement('button');
  addGroup.type = 'button';
  addGroup.className = 'secondary';
  addGroup.textContent = 'Adicionar grupo E/OU';
  actions.append(addRule, addGroup);
  if (!isRoot) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger';
    remove.textContent = 'Remover grupo';
    remove.addEventListener('click', () => {
      const container = panel.parentElement;
      if (container.children.length > 1) panel.remove();
    });
    actions.append(remove);
  }
  header.append(combinatorLabel, actions);
  const children = document.createElement('div');
  children.className = 'filter-group-children';
  addRule.addEventListener('click', () =>
    children.append(createFilterRule({ field: 'displayName', operator: 'contains' })),
  );
  addGroup.addEventListener('click', () =>
    children.append(
      createFilterGroup({
        type: 'group',
        combinator: 'and',
        children: [{ type: 'rule', field: 'displayName', operator: 'contains' }],
      }),
    ),
  );
  for (const child of group.children ?? []) {
    children.append(child.type === 'group' ? createFilterGroup(child) : createFilterRule(child));
  }
  if (children.children.length === 0) children.append(createFilterRule());
  panel.append(header, children);
  return panel;
}

function readFilterNode(element) {
  if (element.dataset.filterNode === 'group') {
    const childrenContainer = [...element.children].find((child) =>
      child.classList.contains('filter-group-children'),
    );
    return {
      type: 'group',
      combinator: element.querySelector(':scope > .filter-group-header .filter-group-combinator')
        .value,
      children: [...childrenContainer.children].map(readFilterNode),
    };
  }
  const row = element;
  const operator = row.querySelector('.filter-operator').value;
  const rawValue = row.querySelector('.filter-value').value.trim();
  const rule = { type: 'rule', field: row.querySelector('.filter-field').value, operator };
  if (!['isEmpty', 'isNotEmpty'].includes(operator)) {
    rule.value = ['in', 'notIn', 'between'].includes(operator)
      ? rawValue
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean)
      : rawValue;
  }
  return rule;
}

function readFilter() {
  return { version: 1, root: readFilterNode(filterRules.firstElementChild) };
}

function renderFilter(definition) {
  filterRules.replaceChildren(createFilterGroup(definition.root, true));
}

async function initializeGoogleContacts() {
  googleLoaded = true;
  let initialFilter = {
    version: 1,
    root: {
      type: 'group',
      combinator: 'and',
      children: [{ type: 'rule', field: 'displayName', operator: 'isNotEmpty' }],
    },
  };
  try {
    if (Number.isSafeInteger(editCampaignId) && editCampaignId > 0) {
      const response = await fetch(`/api/campaigns/${editCampaignId}`);
      const campaign = await response.json();
      if (!response.ok) throw new Error(campaign.message ?? 'Rascunho não encontrado.');
      if (campaign.status !== 'draft' || campaign.selectionSource !== 'google') {
        throw new Error('Somente rascunhos Google podem ter a seleção editada.');
      }
      editingCampaign = campaign;
      const selection = campaign.contactSelection;
      if (!selection?.filter) throw new Error('O rascunho não possui uma seleção Google válida.');
      initialFilter = selection.filter;
      selectAllMatching.checked = selection.selectAllMatching === true;
      for (const id of selection.includedIds ?? []) includedContactIds.add(id);
      for (const id of selection.excludedIds ?? []) excludedContactIds.add(id);
      for (const [contactId, phoneId] of Object.entries(selection.phoneChoices ?? {})) {
        phoneChoices.set(Number(contactId), Number(phoneId));
      }
      document.querySelector('#use-contact-selection').textContent = 'Salvar seleção no rascunho';
    }
    renderFilter(initialFilter);
    const [statusResponse] = await Promise.all([fetch('/api/google/status'), loadSavedFilters()]);
    const status = await statusResponse.json();
    googleStatus.textContent = status.connected
      ? `Conta ${status.account?.email ?? 'Google'} conectada. Os resultados usam a última sincronização local.`
      : 'Google não conectado. Você ainda pode revisar dados já sincronizados ou configurar a conta.';
    await runContactSearch(!editingCampaign);
  } catch (error) {
    showGoogleError(`Não foi possível carregar a agenda: ${error.message}`);
  }
}

async function loadSavedFilters() {
  const response = await fetch('/api/contact-filters');
  const body = await response.json();
  if (!response.ok) throw new Error(body.message ?? 'Falha ao carregar filtros salvos.');
  savedFilter.replaceChildren(new Option('Filtro atual (não salvo)', ''));
  for (const item of body.items) {
    const option = new Option(item.name, String(item.id));
    option.dataset.definition = JSON.stringify(item.definition);
    savedFilter.append(option);
  }
}

async function runContactSearch(resetSelection = false) {
  showGoogleError();
  currentFilter = readFilter();
  if (resetSelection) {
    includedContactIds.clear();
    excludedContactIds.clear();
    phoneChoices.clear();
    selectAllMatching.checked = false;
  }
  const result = await postJson('/api/contacts/search', {
    filter: currentFilter,
    page: contactPage,
    pageSize: 25,
    order: 'name',
  });
  contactTotal = result.total;
  renderGoogleContacts(result.items);
  pageLabel.textContent = `Página ${result.page} — ${contactTotal} resultado${contactTotal === 1 ? '' : 's'}`;
  previousPage.disabled = contactPage <= 1;
  nextPage.disabled = contactPage * result.pageSize >= contactTotal;
  await refreshSelectionSummary();
}

function renderGoogleContacts(items) {
  googleResults.replaceChildren();
  if (items.length === 0) {
    const cell = googleResults.insertRow().insertCell();
    cell.colSpan = 5;
    cell.textContent = 'Nenhum contato corresponde aos filtros.';
    return;
  }
  for (const item of items) {
    const row = googleResults.insertRow();
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.setAttribute('aria-label', `Selecionar ${item.displayName}`);
    checkbox.checked = selectAllMatching.checked
      ? !excludedContactIds.has(item.id)
      : includedContactIds.has(item.id);
    checkbox.addEventListener('change', async () => {
      const target = selectAllMatching.checked ? excludedContactIds : includedContactIds;
      if (selectAllMatching.checked)
        checkbox.checked ? target.delete(item.id) : target.add(item.id);
      else checkbox.checked ? target.add(item.id) : target.delete(item.id);
      await refreshSelectionSummary();
    });
    row.insertCell().append(checkbox);
    row.insertCell().textContent = item.displayName;
    const phoneCell = row.insertCell();
    const chosenPhoneId = phoneChoices.get(item.id);
    const chosenPhone = item.phoneOptions?.find((phone) => phone.id === chosenPhoneId);
    if ((item.phoneOptions?.length ?? 0) > 1) {
      const select = document.createElement('select');
      select.setAttribute('aria-label', `Telefone de ${item.displayName}`);
      if (item.ambiguousPhone && !chosenPhone) {
        select.append(new Option('Escolha o telefone', ''));
      }
      for (const phone of item.phoneOptions) {
        const suffix = `${phone.primary ? ' — principal' : ''}${phone.valid ? '' : ' — inválido'}`;
        select.append(new Option(`${phone.rawValue} (${phone.label})${suffix}`, String(phone.id)));
      }
      if (chosenPhone) select.value = String(chosenPhone.id);
      select.addEventListener('change', async () => {
        if (select.value) phoneChoices.set(item.id, Number(select.value));
        else phoneChoices.delete(item.id);
        try {
          await runContactSearch(false);
        } catch (error) {
          showGoogleError(error.message);
        }
      });
      phoneCell.append(select);
    } else {
      phoneCell.textContent = item.phone ?? item.phoneOriginal ?? 'Sem telefone';
    }
    row.insertCell().textContent = item.labels.join(', ') || '—';
    row.insertCell().textContent =
      item.ambiguousPhone && !chosenPhone
        ? 'Escolha um telefone'
        : item.optedOut
          ? 'Opt-out'
          : !item.phone
            ? 'Sem telefone'
            : !item.phoneValid
              ? 'Inválido'
              : item.duplicatePhone
                ? 'Possível duplicado'
                : 'Válido';
  }
}

async function refreshSelectionSummary() {
  const resolved = await postJson('/api/contacts/resolve-selection', selectionPayload());
  selectionSummary.innerHTML = [
    ['Selecionados', resolved.summary.selected, ''],
    ['Elegíveis', resolved.summary.eligible, 'success'],
    ['Sem/inválidos', resolved.summary.missingPhone + resolved.summary.invalidPhone, 'error-tone'],
    ['Telefone ambíguo', resolved.summary.ambiguousPhone, 'warning'],
    ['Duplicados/opt-out', resolved.summary.duplicatePhone + resolved.summary.optedOut, 'warning'],
  ]
    .map(
      ([label, value, tone]) =>
        `<div class="metric ${tone}"><span>${label}</span><strong>${value}</strong></div>`,
    )
    .join('');
  return resolved;
}

function selectionPayload() {
  return {
    filter: currentFilter ?? readFilter(),
    selectAllMatching: selectAllMatching.checked,
    includedIds: [...includedContactIds],
    excludedIds: [...excludedContactIds],
    phoneChoices: Object.fromEntries(phoneChoices),
    order: 'name',
  };
}

function showGoogleError(message = '') {
  googleError.hidden = !message;
  googleError.textContent = message;
}

document.querySelector('#apply-contact-filter').addEventListener('click', async () => {
  contactPage = 1;
  try {
    await runContactSearch(true);
  } catch (error) {
    showGoogleError(error.message);
  }
});
selectAllMatching.addEventListener('change', async () => {
  includedContactIds.clear();
  excludedContactIds.clear();
  try {
    await runContactSearch(false);
  } catch (error) {
    showGoogleError(error.message);
  }
});
previousPage.addEventListener('click', async () => {
  contactPage -= 1;
  await runContactSearch(false);
});
nextPage.addEventListener('click', async () => {
  contactPage += 1;
  await runContactSearch(false);
});
document.querySelector('#load-filter').addEventListener('click', async () => {
  const option = savedFilter.selectedOptions[0];
  if (!option?.dataset.definition) return;
  renderFilter(JSON.parse(option.dataset.definition));
  filterName.value = option.textContent;
  contactPage = 1;
  await runContactSearch(true);
});
document.querySelector('#save-filter').addEventListener('click', async () => {
  try {
    await postJson('/api/contact-filters', { name: filterName.value, definition: readFilter() });
    await loadSavedFilters();
    filterName.value = '';
  } catch (error) {
    showGoogleError(error.message);
  }
});
document.querySelector('#delete-filter').addEventListener('click', async () => {
  if (!savedFilter.value) return;
  const response = await fetch(`/api/contact-filters/${savedFilter.value}`, { method: 'DELETE' });
  if (!response.ok) return showGoogleError('Não foi possível excluir o filtro salvo.');
  await loadSavedFilters();
});
document.querySelector('#use-contact-selection').addEventListener('click', async () => {
  try {
    const resolved = await refreshSelectionSummary();
    if (resolved.summary.selected === 0) throw new Error('Selecione ao menos um contato.');
    if (editingCampaign) {
      const response = await fetch(`/api/campaigns/${editingCampaign.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: editingCampaign.name,
          contactSelection: resolved.definition,
          messageTemplate: editingCampaign.messageTemplate,
          delayMinSeconds: editingCampaign.delayMinSeconds,
          delayMaxSeconds: editingCampaign.delayMaxSeconds,
          batchSize: editingCampaign.batchSize,
          batchIntervalSeconds: editingCampaign.batchIntervalSeconds,
          batchOrder: editingCampaign.batchOrder,
          ...(editingCampaign.batchOrderSeed
            ? { batchOrderSeed: editingCampaign.batchOrderSeed }
            : {}),
          mediaId: editingCampaign.media?.id ?? null,
        }),
      });
      const updated = await response.json();
      if (!response.ok) {
        throw new Error(
          updated.issues?.map((issue) => issue.message).join(' ') ||
            updated.message ||
            'Não foi possível atualizar a seleção.',
        );
      }
      window.location.href = `/campaign.html?id=${editingCampaign.id}`;
      return;
    }
    sessionStorage.setItem('waDeliveryContactSelection', JSON.stringify(resolved));
    window.location.href = '/campaigns.html?source=google';
  } catch (error) {
    showGoogleError(error.message);
  }
});

function addContactRow(contact = { name: '', phone: '' }) {
  const row = document.createElement('div');
  row.className = 'contact-row';
  row.innerHTML = `
    <label>Nome<input class="contact-name" autocomplete="name" required></label>
    <label>Telefone<input class="contact-phone" inputmode="tel" placeholder="(16) 99999-9999" required></label>
    <button class="remove-contact danger" type="button" aria-label="Remover contato">Remover</button>
  `;
  row.querySelector('.contact-name').value = contact.name;
  row.querySelector('.contact-phone').value = contact.phone;
  row.querySelector('.remove-contact').addEventListener('click', () => {
    if (rows.children.length > 1) row.remove();
  });
  rows.append(row);
}

function readContacts() {
  return [...rows.querySelectorAll('.contact-row')].map((row) => ({
    name: row.querySelector('.contact-name').value,
    phone: row.querySelector('.contact-phone').value,
  }));
}

function showErrors(issues) {
  errors.hidden = issues.length === 0;
  errors.innerHTML = issues.map((issue) => `<div>${escapeHtml(issue.message)}</div>`).join('');
}

function showCsvError(message = '') {
  csvErrors.hidden = !message;
  csvErrors.textContent = message;
}

function options(headers, selected, emptyLabel) {
  const empty = emptyLabel ? `<option value="">${escapeHtml(emptyLabel)}</option>` : '';
  return (
    empty +
    headers
      .map(
        (header) =>
          `<option value="${escapeHtml(header)}" ${header === selected ? 'selected' : ''}>${escapeHtml(header)}</option>`,
      )
      .join('')
  );
}

function renderTable(table, headers, records) {
  table.innerHTML = `
    <thead><tr>${headers.map((header) => `<th>${escapeHtml(header)}</th>`).join('')}</tr></thead>
    <tbody>${records
      .map(
        (record) =>
          `<tr>${headers
            .map((header) => `<td>${escapeHtml(record[header] ?? '')}</td>`)
            .join('')}</tr>`,
      )
      .join('')}</tbody>
  `;
}

async function postJson(path, body) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.message ?? 'Falha ao processar a solicitação.');
  return result;
}

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = value;
  return node.innerHTML;
}

async function loadLists() {
  const response = await fetch('/api/contact-lists');
  const { items } = await response.json();
  savedLists.innerHTML =
    items.length === 0
      ? '<p>Nenhuma lista cadastrada.</p>'
      : items
          .map(
            (item) => `
        <a class="saved-list" href="/contact-list.html?id=${item.id}">
          <div><strong>${escapeHtml(item.name)}</strong><span>${item.source === 'manual' ? 'Manual' : 'CSV'}</span></div>
          <b>${item.contactCount} contato${item.contactCount === 1 ? '' : 's'}</b>
        </a>
      `,
          )
          .join('');
}

addButton.addEventListener('click', () => addContactRow());

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showCsvError();
  csvPreview.hidden = true;
  csvAnalysis.hidden = true;
  const submitButton = uploadForm.querySelector('button');
  submitButton.disabled = true;
  try {
    const formData = new FormData();
    formData.append('file', csvFile.files[0]);
    const response = await fetch('/api/contact-imports/preview', {
      method: 'POST',
      body: formData,
    });
    const preview = await response.json();
    if (!response.ok) throw new Error(preview.message ?? 'Não foi possível analisar o CSV.');
    currentPreview = preview;
    fileSummary.textContent = `${preview.filename} — ${preview.rowCount} linhas — ${preview.encoding} — separador ${preview.delimiter}`;
    phoneColumn.innerHTML = options(preview.headers, preview.phoneCandidates[0]?.header);
    nameColumn.innerHTML = options(
      preview.headers,
      preview.nameCandidates[0]?.header,
      'Não usar coluna de nome',
    );
    renderTable(previewTable, preview.headers, preview.rows);
    importListName.value = preview.filename.replace(/\.csv$/i, '');
    csvPreview.hidden = false;
  } catch (error) {
    showCsvError(error.message);
  } finally {
    submitButton.disabled = false;
  }
});

analyzeMapping.addEventListener('click', async () => {
  showCsvError();
  analyzeMapping.disabled = true;
  try {
    const analysis = await postJson('/api/contact-imports/analyze', {
      previewId: currentPreview.previewId,
      phoneColumn: phoneColumn.value,
      nameColumn: nameColumn.value,
    });
    analysisCards.innerHTML = [
      ['Total', analysis.total, ''],
      ['Válidos', analysis.valid, 'success'],
      ['Inválidos', analysis.invalid, 'error-tone'],
      ['Duplicados', analysis.duplicates, 'warning'],
    ]
      .map(
        ([label, value, tone]) =>
          `<div class="metric ${tone}"><span>${label}</span><strong>${value}</strong></div>`,
      )
      .join('');
    renderTable(
      analysisTable,
      ['Linha', 'Nome', 'Telefone', 'Status', 'Motivo'],
      analysis.sample.map((row) => ({
        Linha: row.rowNumber,
        Nome: row.name,
        Telefone: row.phone,
        Status:
          row.status === 'valid' ? 'Válido' : row.status === 'duplicate' ? 'Duplicado' : 'Inválido',
        Motivo: row.reason ?? '',
      })),
    );
    csvAnalysis.hidden = false;
  } catch (error) {
    showCsvError(error.message);
  } finally {
    analyzeMapping.disabled = false;
  }
});

confirmImport.addEventListener('click', async () => {
  showCsvError();
  confirmImport.disabled = true;
  try {
    await postJson('/api/contact-imports/confirm', {
      previewId: currentPreview.previewId,
      listName: importListName.value,
      phoneColumn: phoneColumn.value,
      nameColumn: nameColumn.value,
    });
    uploadForm.reset();
    csvPreview.hidden = true;
    csvAnalysis.hidden = true;
    currentPreview = undefined;
    await loadLists();
  } catch (error) {
    showCsvError(error.message);
  } finally {
    confirmImport.disabled = false;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  showErrors([]);
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;

  try {
    const response = await fetch('/api/contact-lists/manual', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: listName.value, contacts: readContacts() }),
    });
    const body = await response.json();
    if (!response.ok) {
      showErrors(body.issues ?? [{ message: body.message ?? 'Não foi possível salvar a lista.' }]);
      return;
    }

    form.reset();
    rows.replaceChildren();
    addContactRow();
    await loadLists();
  } catch (error) {
    showErrors([{ message: `Falha ao comunicar com a aplicação: ${error.message}` }]);
  } finally {
    submitButton.disabled = false;
  }
});

addContactRow();
selectTab('google');
loadLists().catch((error) => {
  savedLists.innerHTML = `<p class="error">Falha ao carregar listas: ${escapeHtml(error.message)}</p>`;
});
