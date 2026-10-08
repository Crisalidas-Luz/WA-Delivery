import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { openDatabase } from '../src/database/database.js';
import { compileContactFilter } from '../src/modules/contact-selection/ContactFilterSqlCompiler.js';
import { ContactSelectionRepository } from '../src/modules/contact-selection/ContactSelectionRepository.js';
import { ContactSelectionService } from '../src/modules/contact-selection/ContactSelectionService.js';
import { registerContactSelectionRoutes } from '../src/web/contactSelectionRoutes.js';
import Fastify from 'fastify';

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
      JSON.stringify({
        emailAddresses: [{ value: 'ana@example.com' }],
        addresses: [{ formattedValue: 'Rua das Flores, Ribeirão Preto' }],
        relations: [{ person: 'Beatriz', type: 'sister' }],
        urls: [{ value: 'https://example.com/ana', type: 'profile' }],
        userDefined: [{ key: 'Segmento', value: 'Premium' }],
      }),
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
      assert.equal(repository.search({ filter: filter('address', 'contains', 'flores') }).total, 1);
      assert.equal(
        repository.search({ filter: filter('relation', 'contains', 'beatriz') }).total,
        1,
      );
      assert.equal(
        repository.search({ filter: filter('url', 'contains', 'example.com/ana') }).total,
        1,
      );
      assert.equal(
        repository.search({ filter: filter('userDefined', 'contains', 'premium') }).total,
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

describe('filtros salvos e API de seleção', () => {
  it('resolve todos os resultados com inclusões e exclusões manuais de forma reproduzível', () => {
    const { database, repository } = setup();
    try {
      const service = new ContactSelectionService(repository);
      const ana = repository.search({ filter: filter('displayName', 'contains', 'ana') }).items[0];
      const bruno = repository.search({ filter: filter('displayName', 'contains', 'bruno') })
        .items[0];
      assert.ok(ana);
      assert.ok(bruno);

      const resolved = service.resolveSelection({
        filter: filter('displayName', 'contains', 'ana'),
        selectAllMatching: true,
        includedIds: [bruno.id, bruno.id, 999_999],
        excludedIds: [ana.id],
      });

      assert.deepEqual(resolved.contactIds, [bruno.id]);
      assert.deepEqual(resolved.definition.includedIds, [bruno.id, 999_999]);
      assert.deepEqual(resolved.definition.excludedIds, [ana.id]);
      assert.deepEqual(resolved.summary, {
        selected: 1,
        eligible: 0,
        missingPhone: 1,
        invalidPhone: 0,
        duplicatePhone: 0,
        optedOut: 0,
        ambiguousPhone: 0,
      });
    } finally {
      database.close();
    }
  });

  it('classifica deterministicamente telefones duplicados apenas dentro da seleção', () => {
    const { database, repository } = setup();
    try {
      const ana = repository.search({ filter: filter('displayName', 'contains', 'ana') }).items[0];
      assert.ok(ana?.phone);
      const duplicateId = Number(
        database
          .prepare(
            `INSERT INTO google_contacts
              (account_id, resource_name, display_name, given_name, raw_json)
             VALUES (1, 'people/3', 'Zélia Duplicada', 'Zélia', '{}')`,
          )
          .run().lastInsertRowid,
      );
      database
        .prepare(
          `INSERT INTO google_contact_phones
            (google_contact_id, label, raw_value, normalized_phone, is_primary, is_valid)
           VALUES (?, 'Celular', ?, ?, 1, 1)`,
        )
        .run(duplicateId, ana.phone, ana.phone);

      const resolved = new ContactSelectionService(repository).resolveSelection({
        filter: filter('phone', 'equals', ana.phone),
        selectAllMatching: true,
      });
      assert.equal(resolved.summary.eligible, 1);
      assert.equal(resolved.summary.duplicatePhone, 1);
      assert.deepEqual(resolved.contactIds, [ana.id, duplicateId]);
    } finally {
      database.close();
    }
  });

  it('exige escolha em telefone ambíguo e persiste a opção selecionada', () => {
    const { database, repository } = setup();
    try {
      const ana = repository.search({ filter: filter('displayName', 'contains', 'ana') }).items[0];
      assert.ok(ana);
      database
        .prepare(
          `INSERT INTO google_contact_phones
            (google_contact_id, label, raw_value, normalized_phone, is_primary, is_valid)
           VALUES (?, 'Trabalho', '+55 16 98888-2222', '5516988882222', 0, 1)`,
        )
        .run(ana.id);
      database
        .prepare('UPDATE google_contact_phones SET is_primary = 0 WHERE google_contact_id = ?')
        .run(ana.id);
      const refreshed = repository.searchByIds([ana.id])[0];
      assert.equal(refreshed?.ambiguousPhone, true);
      assert.equal(refreshed?.phoneOptions.length, 2);
      const chosen = refreshed?.phoneOptions.find((phone) => phone.label === 'Trabalho');
      assert.ok(chosen);

      const service = new ContactSelectionService(repository);
      const unresolved = service.resolveSelection({
        filter: filter('displayName', 'contains', 'ana'),
        selectAllMatching: true,
      });
      assert.equal(unresolved.summary.ambiguousPhone, 1);
      assert.equal(unresolved.summary.eligible, 0);
      const resolved = service.resolveSelectionWithContacts({
        filter: filter('displayName', 'contains', 'ana'),
        selectAllMatching: true,
        phoneChoices: { [ana.id]: chosen.id },
      });
      assert.equal(resolved.summary.ambiguousPhone, 0);
      assert.equal(resolved.summary.eligible, 1);
      assert.equal(resolved.contacts[0]?.phone, '5516988882222');
      assert.equal(resolved.definition.phoneChoices?.[ana.id], chosen.id);
    } finally {
      database.close();
    }
  });

  it('cria, edita, lista e exclui filtros salvos', () => {
    const { database, repository } = setup();
    try {
      const service = new ContactSelectionService(repository);
      const created = service.saveFilter({
        name: 'Clientes',
        definition: filter('label', 'contains', 'cliente'),
      });
      assert.equal(service.listSavedFilters()[0]?.name, 'Clientes');
      const updated = service.saveFilter({
        id: created.id,
        name: 'Clientes VIP',
        definition: filter('label', 'contains', 'vip'),
      });
      assert.equal(updated.name, 'Clientes VIP');
      assert.equal(service.deleteSavedFilter(created.id), true);
      assert.equal(service.listSavedFilters().length, 0);
    } finally {
      database.close();
    }
  });

  it('expõe busca e CRUD por rotas com validação estruturada', async () => {
    const { database, repository } = setup();
    const server = Fastify();
    registerContactSelectionRoutes(server, new ContactSelectionService(repository));
    try {
      const search = await server.inject({
        method: 'POST',
        url: '/api/contacts/search',
        payload: { filter: filter('displayName', 'contains', 'ana') },
      });
      assert.equal(search.statusCode, 200);
      assert.equal(search.json().total, 1);

      const resolved = await server.inject({
        method: 'POST',
        url: '/api/contacts/resolve-selection',
        payload: {
          filter: filter('displayName', 'contains', 'ana'),
          selectAllMatching: true,
        },
      });
      assert.equal(resolved.statusCode, 200);
      assert.equal(resolved.json().summary.eligible, 1);

      const invalid = await server.inject({
        method: 'POST',
        url: '/api/contact-filters',
        payload: { name: '', definition: filter('displayName', 'contains', 'ana') },
      });
      assert.equal(invalid.statusCode, 422);

      const created = await server.inject({
        method: 'POST',
        url: '/api/contact-filters',
        payload: { name: 'Anas', definition: filter('displayName', 'contains', 'ana') },
      });
      assert.equal(created.statusCode, 201);
      const id = created.json().id;
      const removed = await server.inject({ method: 'DELETE', url: `/api/contact-filters/${id}` });
      assert.equal(removed.statusCode, 204);
    } finally {
      await server.close();
      database.close();
    }
  });
});
