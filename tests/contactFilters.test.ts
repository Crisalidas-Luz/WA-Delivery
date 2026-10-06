import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  ContactFilterValidationError,
  validateContactFilter,
} from '../src/modules/contact-selection/filterTypes.js';

describe('validateContactFilter', () => {
  it('aceita grupos AND/OR com campos e operadores permitidos', () => {
    const filter = validateContactFilter({
      version: 1,
      root: {
        type: 'group',
        combinator: 'and',
        children: [
          { type: 'rule', field: 'displayName', operator: 'contains', value: 'Ana' },
          {
            type: 'group',
            combinator: 'or',
            children: [
              { type: 'rule', field: 'label', operator: 'equals', value: 'Clientes' },
              { type: 'rule', field: 'phone', operator: 'startsWith', value: '5516' },
            ],
          },
        ],
      },
    });
    assert.equal(filter.version, 1);
    assert.equal(filter.root.children.length, 2);
  });

  it('rejeita campos e operadores fora da allowlist', () => {
    assert.throws(
      () =>
        validateContactFilter({
          version: 1,
          root: {
            type: 'group',
            combinator: 'and',
            children: [{ type: 'rule', field: 'sql', operator: 'dropTable', value: 'contacts' }],
          },
        }),
      (error: unknown) =>
        error instanceof ContactFilterValidationError && error.issues.length === 2,
    );
  });

  it('rejeita grupos vazios e regras sem valor', () => {
    assert.throws(() =>
      validateContactFilter({
        version: 1,
        root: {
          type: 'group',
          combinator: 'and',
          children: [{ type: 'rule', field: 'displayName', operator: 'contains' }],
        },
      }),
    );
    assert.throws(() =>
      validateContactFilter({
        version: 1,
        root: { type: 'group', combinator: 'and', children: [] },
      }),
    );
  });
});
