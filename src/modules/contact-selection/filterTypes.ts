export const CONTACT_FILTER_VERSION = 1 as const;

export const CONTACT_FILTER_FIELDS = [
  'displayName',
  'givenName',
  'middleName',
  'familyName',
  'nickname',
  'phone',
  'phoneLabel',
  'email',
  'address',
  'relation',
  'url',
  'userDefined',
  'organizationName',
  'organizationTitle',
  'organizationDepartment',
  'birthday',
  'biography',
  'label',
  'source',
  'phoneValidity',
  'duplicateState',
  'optOut',
  'remoteUpdatedAt',
] as const;

export type ContactFilterField = (typeof CONTACT_FILTER_FIELDS)[number];

export const CONTACT_FILTER_OPERATORS = [
  'contains',
  'notContains',
  'equals',
  'notEquals',
  'startsWith',
  'endsWith',
  'isEmpty',
  'isNotEmpty',
  'before',
  'after',
  'between',
  'in',
  'notIn',
] as const;

export type ContactFilterOperator = (typeof CONTACT_FILTER_OPERATORS)[number];

export interface ContactFilterRule {
  type: 'rule';
  field: ContactFilterField;
  operator: ContactFilterOperator;
  value?: string | boolean | string[];
}

export interface ContactFilterGroup {
  type: 'group';
  combinator: 'and' | 'or';
  children: ContactFilterNode[];
}

export type ContactFilterNode = ContactFilterRule | ContactFilterGroup;

export interface ContactFilterDefinition {
  version: typeof CONTACT_FILTER_VERSION;
  root: ContactFilterGroup;
}

export class ContactFilterValidationError extends Error {
  public constructor(public readonly issues: Array<{ path: string; message: string }>) {
    super('O filtro de contatos é inválido.');
    this.name = 'ContactFilterValidationError';
  }
}

export function validateContactFilter(input: unknown): ContactFilterDefinition {
  const issues: Array<{ path: string; message: string }> = [];
  if (!isRecord(input) || input.version !== CONTACT_FILTER_VERSION) {
    issues.push({ path: 'version', message: 'Versão de filtro não suportada.' });
  }
  const root = isRecord(input) ? input.root : undefined;
  validateNode(root, 'root', issues, 0);
  if (issues.length > 0) throw new ContactFilterValidationError(issues);
  return input as unknown as ContactFilterDefinition;
}

function validateNode(
  node: unknown,
  path: string,
  issues: Array<{ path: string; message: string }>,
  depth: number,
): void {
  if (depth > 10) {
    issues.push({ path, message: 'O filtro excede o limite de 10 níveis.' });
    return;
  }
  if (!isRecord(node)) {
    issues.push({ path, message: 'Nó de filtro inválido.' });
    return;
  }
  if (node.type === 'group') {
    if (node.combinator !== 'and' && node.combinator !== 'or') {
      issues.push({ path: `${path}.combinator`, message: 'Use and ou or.' });
    }
    if (!Array.isArray(node.children) || node.children.length === 0) {
      issues.push({ path: `${path}.children`, message: 'O grupo deve ter ao menos um item.' });
      return;
    }
    if (node.children.length > 100) {
      issues.push({ path: `${path}.children`, message: 'O grupo aceita no máximo 100 itens.' });
      return;
    }
    node.children.forEach((child, index) =>
      validateNode(child, `${path}.children.${index}`, issues, depth + 1),
    );
    return;
  }
  if (node.type !== 'rule') {
    issues.push({ path: `${path}.type`, message: 'Tipo de nó desconhecido.' });
    return;
  }
  if (!(CONTACT_FILTER_FIELDS as readonly unknown[]).includes(node.field)) {
    issues.push({ path: `${path}.field`, message: 'Campo de filtro não permitido.' });
  }
  if (!(CONTACT_FILTER_OPERATORS as readonly unknown[]).includes(node.operator)) {
    issues.push({ path: `${path}.operator`, message: 'Operador de filtro não permitido.' });
  }
  if (!['isEmpty', 'isNotEmpty'].includes(String(node.operator)) && node.value === undefined) {
    issues.push({ path: `${path}.value`, message: 'Informe um valor para o filtro.' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
