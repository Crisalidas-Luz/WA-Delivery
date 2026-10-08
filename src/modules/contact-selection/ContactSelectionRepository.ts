import type { DatabaseSync } from 'node:sqlite';
import { compileContactFilter } from './ContactFilterSqlCompiler.js';
import type { ContactFilterDefinition } from './filterTypes.js';

export interface ContactSearchInput {
  filter: unknown;
  page?: number;
  pageSize?: number;
  order?: 'name' | 'google';
}

export interface ContactSearchItem {
  id: number;
  resourceName: string;
  displayName: string;
  phone?: string;
  phoneOriginal?: string;
  phoneLabel?: string;
  phoneValid: boolean;
  phoneOptions: Array<{
    id: number;
    label: string;
    rawValue: string;
    normalizedPhone?: string;
    primary: boolean;
    valid: boolean;
  }>;
  ambiguousPhone: boolean;
  templateData: Record<string, string>;
  labels: string[];
  remoteDeleted: boolean;
  optedOut: boolean;
  duplicatePhone: boolean;
}

export interface ContactSearchResult {
  items: ContactSearchItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SavedContactFilter {
  id: number;
  name: string;
  definition: ContactFilterDefinition;
  createdAt: string;
  updatedAt: string;
}

export class ContactSelectionRepository {
  public constructor(private readonly database: DatabaseSync) {}

  public search(input: ContactSearchInput): ContactSearchResult {
    const compiled = compileContactFilter(input.filter);
    const page = positiveInteger(input.page, 1);
    const pageSize = Math.min(100, positiveInteger(input.pageSize, 25));
    const offset = (page - 1) * pageSize;
    const where = `gc.account_id = 1 AND gc.remote_deleted = 0 AND ${compiled.sql}`;
    const total = Number(
      this.database
        .prepare(`SELECT COUNT(*) AS total FROM google_contacts gc WHERE ${where}`)
        .get(...compiled.parameters)?.total ?? 0,
    );
    const order = input.order === 'google' ? 'gc.id ASC' : 'LOWER(gc.display_name) ASC, gc.id ASC';
    const rows = this.database
      .prepare(
        `SELECT gc.id, gc.resource_name, gc.display_name, gc.given_name, gc.middle_name,
          gc.family_name, gc.nickname, gc.organization_name, gc.organization_title,
          gc.organization_department, gc.birthday, gc.biography, gc.raw_json, gc.remote_deleted,
          (SELECT normalized_phone FROM google_contact_phones primary_phone
           WHERE primary_phone.google_contact_id = gc.id
           ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
           LIMIT 1) AS phone,
          (SELECT label FROM google_contact_phones primary_phone
           WHERE primary_phone.google_contact_id = gc.id
           ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
           LIMIT 1) AS phone_label,
          (SELECT raw_value FROM google_contact_phones primary_phone
           WHERE primary_phone.google_contact_id = gc.id
           ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
           LIMIT 1) AS phone_original,
          (SELECT is_valid FROM google_contact_phones primary_phone
           WHERE primary_phone.google_contact_id = gc.id
           ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
           LIMIT 1) AS phone_valid,
          (SELECT GROUP_CONCAT(name, char(31)) FROM google_contact_labels labels
           WHERE labels.google_contact_id = gc.id) AS labels,
          EXISTS (SELECT 1 FROM google_contact_phones own_phone
            JOIN contacts local_contact ON local_contact.normalized_phone = own_phone.normalized_phone
            WHERE own_phone.google_contact_id = gc.id AND local_contact.opted_out = 1) AS opted_out,
          (SELECT COUNT(*) FROM google_contact_phones duplicate_phone
            WHERE duplicate_phone.normalized_phone IS NOT NULL
              AND duplicate_phone.normalized_phone = (
                SELECT normalized_phone FROM google_contact_phones primary_phone
                WHERE primary_phone.google_contact_id = gc.id
                ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
                LIMIT 1
              )) > 1 AS duplicate_phone
         FROM google_contacts gc WHERE ${where}
         ORDER BY ${order} LIMIT ? OFFSET ?`,
      )
      .all(...compiled.parameters, pageSize, offset) as unknown as ContactSearchRow[];
    return {
      items: hydratePhoneOptions(this.database, rows.map(toSearchItem)),
      total,
      page,
      pageSize,
    };
  }

  public searchByIds(ids: number[]): ContactSearchItem[] {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(', ');
    const rows = this.database
      .prepare(
        `${contactSelectSql}
         FROM google_contacts gc
         WHERE gc.account_id = 1 AND gc.remote_deleted = 0 AND gc.id IN (${placeholders})
         ORDER BY gc.id ASC`,
      )
      .all(...ids) as unknown as ContactSearchRow[];
    return hydratePhoneOptions(this.database, rows.map(toSearchItem));
  }

  public listSavedFilters(): SavedContactFilter[] {
    return (
      this.database
        .prepare(
          `SELECT id, name, definition_json, created_at, updated_at
           FROM saved_contact_filters ORDER BY LOWER(name), id`,
        )
        .all() as unknown as SavedFilterRow[]
    ).map(toSavedFilter);
  }

  public saveFilter(
    name: string,
    definition: ContactFilterDefinition,
    id?: number,
  ): SavedContactFilter {
    let filterId = id;
    if (id) {
      const result = this.database
        .prepare(
          `UPDATE saved_contact_filters SET name = ?, definition_json = ?,
            updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        )
        .run(name, JSON.stringify(definition), id);
      if (result.changes === 0) throw new Error('Filtro salvo não encontrado.');
    } else {
      filterId = Number(
        this.database
          .prepare('INSERT INTO saved_contact_filters (name, definition_json) VALUES (?, ?)')
          .run(name, JSON.stringify(definition)).lastInsertRowid,
      );
    }
    if (!filterId) throw new Error('Não foi possível determinar o filtro salvo.');
    const row = this.database
      .prepare(
        `SELECT id, name, definition_json, created_at, updated_at
         FROM saved_contact_filters WHERE id = ?`,
      )
      .get(filterId) as unknown as SavedFilterRow;
    return toSavedFilter(row);
  }

  public deleteSavedFilter(id: number): boolean {
    return (
      this.database.prepare('DELETE FROM saved_contact_filters WHERE id = ?').run(id).changes > 0
    );
  }
}

const contactSelectSql = `SELECT gc.id, gc.resource_name, gc.display_name, gc.given_name,
  gc.middle_name, gc.family_name, gc.nickname, gc.organization_name, gc.organization_title,
  gc.organization_department, gc.birthday, gc.biography, gc.raw_json, gc.remote_deleted,
  (SELECT normalized_phone FROM google_contact_phones primary_phone
   WHERE primary_phone.google_contact_id = gc.id
   ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
   LIMIT 1) AS phone,
  (SELECT label FROM google_contact_phones primary_phone
   WHERE primary_phone.google_contact_id = gc.id
   ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
   LIMIT 1) AS phone_label,
  (SELECT raw_value FROM google_contact_phones primary_phone
   WHERE primary_phone.google_contact_id = gc.id
   ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
   LIMIT 1) AS phone_original,
  (SELECT is_valid FROM google_contact_phones primary_phone
   WHERE primary_phone.google_contact_id = gc.id
   ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
   LIMIT 1) AS phone_valid,
  (SELECT GROUP_CONCAT(name, char(31)) FROM google_contact_labels labels
   WHERE labels.google_contact_id = gc.id) AS labels,
  EXISTS (SELECT 1 FROM google_contact_phones own_phone
    JOIN contacts local_contact ON local_contact.normalized_phone = own_phone.normalized_phone
    WHERE own_phone.google_contact_id = gc.id AND local_contact.opted_out = 1) AS opted_out,
  (SELECT COUNT(*) FROM google_contact_phones duplicate_phone
    WHERE duplicate_phone.normalized_phone IS NOT NULL
      AND duplicate_phone.normalized_phone = (
        SELECT normalized_phone FROM google_contact_phones primary_phone
        WHERE primary_phone.google_contact_id = gc.id
        ORDER BY primary_phone.is_primary DESC, primary_phone.is_valid DESC, primary_phone.id
        LIMIT 1
      )) > 1 AS duplicate_phone`;

interface ContactSearchRow {
  id: number;
  resource_name: string;
  display_name: string;
  given_name: string;
  middle_name: string;
  family_name: string;
  nickname: string;
  organization_name: string;
  organization_title: string;
  organization_department: string;
  birthday: string | null;
  biography: string;
  raw_json: string;
  remote_deleted: number;
  phone: string | null;
  phone_label: string | null;
  phone_original: string | null;
  phone_valid: number | null;
  labels: string | null;
  opted_out: number;
  duplicate_phone: number;
}

function toSearchItem(row: ContactSearchRow): ContactSearchItem {
  const labels = row.labels ? row.labels.split(String.fromCharCode(31)) : [];
  const raw = parseObject(row.raw_json);
  const templateData = compactTemplateData({
    nome: row.display_name,
    primeiro_nome: row.given_name,
    nome_do_meio: row.middle_name,
    sobrenome: row.family_name,
    apelido: row.nickname,
    telefone: row.phone ?? row.phone_original ?? '',
    tipo_telefone: row.phone_label ?? '',
    email: firstValue(raw.emailAddresses),
    organizacao: row.organization_name,
    cargo: row.organization_title,
    departamento: row.organization_department,
    aniversario: row.birthday ?? '',
    notas: row.biography,
    labels: labels.join(', '),
    endereco: firstFormattedValue(raw.addresses),
    url: firstValue(raw.urls),
    relacao: firstValue(raw.relations),
    ...userDefinedValues(raw.userDefined),
  });
  return {
    id: row.id,
    resourceName: row.resource_name,
    displayName: row.display_name,
    ...(row.phone ? { phone: row.phone } : {}),
    ...(row.phone_label ? { phoneLabel: row.phone_label } : {}),
    ...(row.phone_original ? { phoneOriginal: row.phone_original } : {}),
    phoneValid: row.phone_valid === 1,
    phoneOptions: [],
    ambiguousPhone: false,
    labels,
    remoteDeleted: row.remote_deleted === 1,
    optedOut: row.opted_out === 1,
    duplicatePhone: row.duplicate_phone === 1,
    templateData,
  };
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function firstValue(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const first = value[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return '';
  const record = first as Record<string, unknown>;
  return typeof record.value === 'string' ? record.value : '';
}

function firstFormattedValue(value: unknown): string {
  if (!Array.isArray(value)) return '';
  const first = value[0];
  if (typeof first !== 'object' || first === null || Array.isArray(first)) return '';
  const record = first as Record<string, unknown>;
  return typeof record.formattedValue === 'string' ? record.formattedValue : firstValue(value);
}

function userDefinedValues(value: unknown): Record<string, string> {
  if (!Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    if (typeof record.key !== 'string' || typeof record.value !== 'string') continue;
    const key = `personalizado_${record.key
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')}`;
    if (key !== 'personalizado_') result[key] = record.value;
  }
  return result;
}

function compactTemplateData(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== ''));
}

function hydratePhoneOptions(
  database: DatabaseSync,
  items: ContactSearchItem[],
): ContactSearchItem[] {
  if (items.length === 0) return items;
  const placeholders = items.map(() => '?').join(', ');
  const rows = database
    .prepare(
      `SELECT id, google_contact_id, label, raw_value, normalized_phone, is_primary, is_valid
       FROM google_contact_phones WHERE google_contact_id IN (${placeholders})
       ORDER BY google_contact_id, is_primary DESC, is_valid DESC, id`,
    )
    .all(...items.map((item) => item.id)) as unknown as Array<{
    id: number;
    google_contact_id: number;
    label: string;
    raw_value: string;
    normalized_phone: string | null;
    is_primary: number;
    is_valid: number;
  }>;
  const byContact = new Map<number, ContactSearchItem['phoneOptions']>();
  for (const row of rows) {
    const options = byContact.get(row.google_contact_id) ?? [];
    options.push({
      id: row.id,
      label: row.label,
      rawValue: row.raw_value,
      ...(row.normalized_phone ? { normalizedPhone: row.normalized_phone } : {}),
      primary: row.is_primary === 1,
      valid: row.is_valid === 1,
    });
    byContact.set(row.google_contact_id, options);
  }
  return items.map((item) => {
    const phoneOptions = byContact.get(item.id) ?? [];
    const valid = phoneOptions.filter((phone) => phone.valid && phone.normalizedPhone);
    const primaryValid = valid.filter((phone) => phone.primary);
    return {
      ...item,
      phoneOptions,
      ambiguousPhone: valid.length > 1 && primaryValid.length !== 1,
    };
  });
}

interface SavedFilterRow {
  id: number;
  name: string;
  definition_json: string;
  created_at: string;
  updated_at: string;
}

function toSavedFilter(row: SavedFilterRow): SavedContactFilter {
  return {
    id: row.id,
    name: row.name,
    definition: JSON.parse(row.definition_json) as ContactFilterDefinition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}
