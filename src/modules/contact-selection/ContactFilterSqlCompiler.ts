import type { SQLInputValue } from 'node:sqlite';
import {
  validateContactFilter,
  type ContactFilterDefinition,
  type ContactFilterGroup,
  type ContactFilterRule,
} from './filterTypes.js';

export interface CompiledContactFilter {
  sql: string;
  parameters: SQLInputValue[];
  definition: ContactFilterDefinition;
}

export function compileContactFilter(input: unknown): CompiledContactFilter {
  const definition = validateContactFilter(input);
  const parameters: SQLInputValue[] = [];
  return { sql: compileGroup(definition.root, parameters), parameters, definition };
}

function compileGroup(group: ContactFilterGroup, parameters: SQLInputValue[]): string {
  const separator = group.combinator === 'and' ? ' AND ' : ' OR ';
  return `(${group.children
    .map((child) =>
      child.type === 'group' ? compileGroup(child, parameters) : compileRule(child, parameters),
    )
    .join(separator)})`;
}

function compileRule(rule: ContactFilterRule, parameters: SQLInputValue[]): string {
  if (rule.field === 'source') return compileSource(rule, parameters);
  if (rule.field === 'label') {
    return compileExpression(
      `EXISTS (SELECT 1 FROM google_contact_labels filter_label
        WHERE filter_label.google_contact_id = gc.id AND LOWER(filter_label.name)`,
      rule,
      parameters,
      ')',
    );
  }
  if (rule.field === 'phone' || rule.field === 'phoneLabel') {
    const column = rule.field === 'phone' ? 'filter_phone.normalized_phone' : 'filter_phone.label';
    return compileExpression(
      `EXISTS (SELECT 1 FROM google_contact_phones filter_phone
        WHERE filter_phone.google_contact_id = gc.id AND LOWER(COALESCE(${column}, ''))`,
      rule,
      parameters,
      ')',
    );
  }
  const jsonField = JSON_ARRAY_FIELDS[rule.field as keyof typeof JSON_ARRAY_FIELDS];
  if (jsonField) {
    return compileExpression(
      `EXISTS (SELECT 1 FROM json_each(gc.raw_json, '${jsonField.path}') filter_json
        WHERE LOWER(COALESCE(${jsonField.expression}, ''))`,
      rule,
      parameters,
      ')',
    );
  }
  if (rule.field === 'phoneValidity') {
    const valid = String(rule.value).toLowerCase() === 'valid';
    parameters.push(valid ? 1 : 0);
    return `EXISTS (SELECT 1 FROM google_contact_phones filter_phone
      WHERE filter_phone.google_contact_id = gc.id AND filter_phone.is_valid = ?)`;
  }
  if (rule.field === 'duplicateState') {
    const duplicate = String(rule.value).toLowerCase() === 'duplicate';
    const expression = `(SELECT COUNT(*) FROM google_contact_phones duplicate_phone
      WHERE duplicate_phone.normalized_phone IN (
        SELECT normalized_phone FROM google_contact_phones own_phone
        WHERE own_phone.google_contact_id = gc.id AND own_phone.normalized_phone IS NOT NULL
      ))`;
    return duplicate ? `${expression} > 1` : `${expression} <= 1`;
  }
  if (rule.field === 'optOut') {
    const optedOut = rule.value === true || String(rule.value).toLowerCase() === 'true';
    const exists = `EXISTS (SELECT 1 FROM google_contact_phones own_phone
      JOIN contacts local_contact ON local_contact.normalized_phone = own_phone.normalized_phone
      WHERE own_phone.google_contact_id = gc.id AND local_contact.opted_out = 1)`;
    return optedOut ? exists : `NOT ${exists}`;
  }
  if (!(rule.field in FIELD_EXPRESSIONS)) throw new Error('Campo de filtro sem compilador SQL.');
  const column = FIELD_EXPRESSIONS[rule.field as keyof typeof FIELD_EXPRESSIONS];
  return compileExpression(`LOWER(COALESCE(${column}, ''))`, rule, parameters);
}

const FIELD_EXPRESSIONS = {
  displayName: 'gc.display_name',
  givenName: 'gc.given_name',
  middleName: 'gc.middle_name',
  familyName: 'gc.family_name',
  nickname: 'gc.nickname',
  organizationName: 'gc.organization_name',
  organizationTitle: 'gc.organization_title',
  organizationDepartment: 'gc.organization_department',
  birthday: 'gc.birthday',
  biography: 'gc.biography',
  remoteUpdatedAt: 'gc.remote_updated_at',
} as const;

const JSON_ARRAY_FIELDS = {
  email: {
    path: '$.emailAddresses',
    expression: "json_extract(filter_json.value, '$.value')",
  },
  address: {
    path: '$.addresses',
    expression: `COALESCE(json_extract(filter_json.value, '$.formattedValue'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.streetAddress'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.city'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.region'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.postalCode'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.country'), '')`,
  },
  relation: {
    path: '$.relations',
    expression: `COALESCE(json_extract(filter_json.value, '$.person'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.type'), '')`,
  },
  url: {
    path: '$.urls',
    expression: `COALESCE(json_extract(filter_json.value, '$.value'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.type'), '')`,
  },
  userDefined: {
    path: '$.userDefined',
    expression: `COALESCE(json_extract(filter_json.value, '$.key'), '') || ' ' ||
      COALESCE(json_extract(filter_json.value, '$.value'), '')`,
  },
} as const;

function compileSource(rule: ContactFilterRule, parameters: SQLInputValue[]): string {
  const expected = String(rule.value).toLowerCase();
  parameters.push(expected);
  if (rule.operator === 'notEquals' || rule.operator === 'notIn') return "'google' <> ?";
  return "'google' = ?";
}

function compileExpression(
  expression: string,
  rule: ContactFilterRule,
  parameters: SQLInputValue[],
  suffix = '',
): string {
  const values = Array.isArray(rule.value) ? rule.value.map(normalize) : [normalize(rule.value)];
  switch (rule.operator) {
    case 'contains':
      parameters.push(`%${escapeLike(values[0] ?? '')}%`);
      return `${expression} LIKE ? ESCAPE '\\'${suffix}`;
    case 'notContains':
      parameters.push(`%${escapeLike(values[0] ?? '')}%`);
      return `${expression} NOT LIKE ? ESCAPE '\\'${suffix}`;
    case 'equals':
      parameters.push(values[0] ?? '');
      return `${expression} = ?${suffix}`;
    case 'notEquals':
      parameters.push(values[0] ?? '');
      return `${expression} <> ?${suffix}`;
    case 'startsWith':
      parameters.push(`${escapeLike(values[0] ?? '')}%`);
      return `${expression} LIKE ? ESCAPE '\\'${suffix}`;
    case 'endsWith':
      parameters.push(`%${escapeLike(values[0] ?? '')}`);
      return `${expression} LIKE ? ESCAPE '\\'${suffix}`;
    case 'isEmpty':
      return `${expression} = ''${suffix}`;
    case 'isNotEmpty':
      return `${expression} <> ''${suffix}`;
    case 'before':
      parameters.push(values[0] ?? '');
      return `${expression} < ?${suffix}`;
    case 'after':
      parameters.push(values[0] ?? '');
      return `${expression} > ?${suffix}`;
    case 'between':
      parameters.push(values[0] ?? '', values[1] ?? '');
      return `${expression} BETWEEN ? AND ?${suffix}`;
    case 'in':
    case 'notIn': {
      const list = values.length > 0 ? values : [''];
      parameters.push(...list);
      return `${expression} ${rule.operator === 'notIn' ? 'NOT IN' : 'IN'} (${list.map(() => '?').join(', ')})${suffix}`;
    }
  }
}

function normalize(value: unknown): string {
  return String(value ?? '')
    .trim()
    .toLocaleLowerCase('pt-BR');
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}
