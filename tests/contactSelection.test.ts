import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/database/database.js';
import { compileContactFilter } from '../src/modules/contact-selection/ContactFilterSqlCompiler.js';
import { ContactSelectionRepository } from '../src/modules/contact-selection/ContactSelectionRepository.js';

function filter(field: string, operator: string, value?: unknown) {
  return {
    version: 1,
    root: {
      type: 'group',
      combinator: 'and',
      children: [{ type: 'rule', field, operator, ...(value === undefined ? {} : { value }) }],
    },
  };
}

function setup() {
  const database = openDatabase(':memory:');
  database
    .prepare(
      `INSERT INTO google_accounts
        (id, google_subject, email, display_name, token_store_key)
       VALUES (1, 'sub', 'user@example.com', 'User', 'google:sub')`,
    )
    .run();
  const insertContact = database.prepare(
    `INSERT INTO google_contacts
      (account_id, resource_name, display_name, given_name, family_name,
       organization_name, raw_json)
     VALUES (1, ?, ?, ?, ?, ?, ?)`,
  );
  const ana = Number(
    insertContact.run(
      'people/1',
      'Ana Ávila',
      'Ana',
      'Ávila',
      'Crisálidas',
      JSON.stringify({ emailAddresses: [{ value: 'ana@example.com' }] }),
    ).lastInsertRowid,
  );
  const bruno = Number(
    insertContact.run(
      'people/2',
      'Bruno Lima',
      'Bruno',
      'Lima',
      'Outra',
      JSON.stringify({ emailAddresses: [{ value: 'bruno@example.com' }] }),
    ).lastInsertRowid,
  );
  const phone = database.prepare(
    `INSERT INTO google_contact_phones
      (google_contact_id, label, raw_value, normalized_phone, is_primary, is_valid)
     VALUES (?, 'Celular', ?, ?, 1, ?)`,
  );
  phone.run(ana, '+55 16 99999-1111', '5516999991111', 1);
  phone.run(bruno, '123', null, 0);
  database
    .prepare(
      `INSERT INTO google_contact_labels (google_contact_id, resource_name, name)
       VALUES (?, 'contactGroups/clientes', 'Clientes VIP')`,
    )
    .run(ana);
  return { database, repository: new ContactSelectionRepository(database) };
}

describe('compileContactFilter', () => {
  it('gera SQL parametrizado e escapa curingas de LIKE', () => {
    const compiled = compileContactFilter(filter('displayName', 'contains', "Ana%' OR 1=1 --"));
    assert.ok(!compiled.sql.includes('OR 1=1'));
    assert.equal(compiled.parameters.length, 1);
    assert.match(String(compiled.parameters[0]), /\\%/);
  });

  it('compila grupos aninhados sem aceitar nomes de campo livres', () => {
    const compiled = compileContactFilter({
      version: 1,
      root: {
        type: 'group',
        combinator: 'or',
        children: [
          { type: 'rule', field: 'organizationName', operator: 'equals', value: 'Crisálidas' },
          { type: 'rule', field: 'label', operator: 'contains', value: 'VIP' },
        ],
      },
    });
    assert.match(compiled.sql, / OR /);
    assert.deepEqual(compiled.parameters, ['crisálidas', '%vip%']);
  });
});

describe('ContactSelectionRepository', () => {
  it('busca por nome e retorna telefone principal, validade e labels', () => {
    const { database, repository } = setup();
    try {
      const result = repository.search({ filter: filter('givenName', 'equals', 'ANA') });
      assert.equal(result.total, 1);
      assert.equal(result.items[0]?.displayName, 'Ana Ávila');
      assert.equal(result.items[0]?.phone, '5516999991111');
      assert.equal(result.items[0]?.phoneValid, true);
      assert.deepEqual(result.items[0]?.labels, ['Clientes VIP']);
    } finally {
      database.close();
    }
  });

  it('filtra labels, telefone inválido e conteúdo preservado no JSON', () => {
    const { database, repository } = setup();
    try {
      assert.equal(repository.search({ filter: filter('label', 'contains', 'vip') }).total, 1);
      assert.equal(
        repository.search({ filter: filter('phoneValidity', 'equals', 'invalid') }).items[0]
          ?.displayName,
        'Bruno Lima',
      );
      assert.equal(
        repository.search({ filter: filter('email', 'contains', 'ana@example.com') }).total,
        1,
      );
    } finally {
      database.close();
    }
  });

  it('pagina com limite máximo de 100 e não executa texto malicioso', () => {
    const { database, repository } = setup();
    try {
      const result = repository.search({
        filter: filter('displayName', 'contains', "%' OR 1=1 --"),
        pageSize: 999,
      });
      assert.equal(result.total, 0);
      assert.equal(result.pageSize, 100);
      assert.equal(
        database.prepare('SELECT COUNT(*) AS count FROM google_contacts').get()?.count,
        2,
      );
    } finally {
      database.close();
    }
  });
});
