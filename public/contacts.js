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
const filterCombinator = document.querySelector('#filter-combinator');
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

const contactFields = {
  displayName: 'Nome exibido',
  givenName: 'Nome',
  middleName: 'Nome do meio',
  familyName: 'Sobrenome',
  nickname: 'Apelido',
  phone: 'Telefone',
  phoneLabel: 'Tipo do telefone',
  email: 'E-mail',
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

function addFilterRule(rule = { field: 'displayName', operator: 'isNotEmpty' }) {
  const row = document.createElement('div');
  row.className = 'filter-rule';
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
    if (filterRules.children.length > 1) row.remove();
  });
  updateValueState();
  filterRules.append(row);
}

function readFilter() {
  const children = [...filterRules.querySelectorAll('.filter-rule')].map((row) => {
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
  });
  return { version: 1, root: { type: 'group', combinator: filterCombinator.value, children } };
}

function renderFilter(definition) {
  filterCombinator.value = definition.root.combinator;
  filterRules.replaceChildren();
  for (const child of definition.root.children) if (child.type === 'rule') addFilterRule(child);
  if (filterRules.children.length === 0) addFilterRule();
}

async function initializeGoogleContacts() {
  googleLoaded = true;
  addFilterRule();
  try {
    const [statusResponse] = await Promise.all([fetch('/api/google/status'), loadSavedFilters()]);
    const status = await statusResponse.json();
    googleStatus.textContent = status.connected
      ? `Conta ${status.account?.email ?? 'Google'} conectada. Os resultados usam a última sincronização local.`
      : 'Google não conectado. Você ainda pode revisar dados já sincronizados ou configurar a conta.';
    await runContactSearch(true);
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
    row.insertCell().textContent = item.phone ?? 'Sem telefone';
    row.insertCell().textContent = item.labels.join(', ') || '—';
    row.insertCell().textContent = item.optedOut
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
    order: 'name',
  };
}

function showGoogleError(message = '') {
  googleError.hidden = !message;
  googleError.textContent = message;
}

document
  .querySelector('#add-filter-rule')
  .addEventListener('click', () => addFilterRule({ field: 'displayName', operator: 'contains' }));
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
