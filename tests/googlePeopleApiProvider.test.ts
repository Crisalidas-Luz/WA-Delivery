import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  GoogleContactNotFoundError,
  GoogleSyncTokenExpiredError,
} from '../src/providers/google/GooglePeopleProvider.js';
import { GooglePeopleApiProvider } from '../src/providers/google/people/GooglePeopleApiProvider.js';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  redirectUri: 'http://127.0.0.1:3000/api/google/oauth/callback',
};

describe('GooglePeopleApiProvider OAuth', () => {
  it('gera state e PKCE e aceita o callback uma única vez', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fakeFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.includes('/token')) {
        return Response.json({
          access_token: 'access',
          refresh_token: 'refresh',
          expires_in: 3600,
          scope: 'openid email profile https://www.googleapis.com/auth/contacts',
        });
      }
      return Response.json({ sub: 'subject', email: 'user@example.com', name: 'Usuário' });
    };
    const provider = new GooglePeopleApiProvider(config, fakeFetch as typeof fetch);
    const start = await provider.createAuthorizationRequest();
    const authorizationUrl = new URL(start.authorizationUrl);
    assert.equal(authorizationUrl.searchParams.get('state'), start.state);
    assert.equal(authorizationUrl.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(authorizationUrl.searchParams.get('code_challenge'));

    const result = await provider.finishAuthorization('authorization-code', start.state);
    assert.equal(result.account.email, 'user@example.com');
    assert.equal(result.tokens.refreshToken, 'refresh');
    const tokenBody = String(calls[0]?.init?.body);
    assert.ok(tokenBody.includes('code_verifier='));
    await assert.rejects(
      () => provider.finishAuthorization('again', start.state),
      /expirou|inválida/,
    );
  });

  it('rejeita state desconhecido sem chamar o Google', async () => {
    let called = false;
    const provider = new GooglePeopleApiProvider(config, (async () => {
      called = true;
      return Response.json({});
    }) as typeof fetch);
    await assert.rejects(() => provider.finishAuthorization('code', 'unknown'), /expirou|inválida/);
    assert.equal(called, false);
  });

  it('rejeita state expirado sem trocar o código por tokens', async () => {
    let now = 1_000;
    let called = false;
    const provider = new GooglePeopleApiProvider(
      { ...config, authorizationTtlMs: 100 },
      (async () => {
        called = true;
        return Response.json({});
      }) as typeof fetch,
      () => now,
    );
    const start = await provider.createAuthorizationRequest();
    now += 101;
    await assert.rejects(() => provider.finishAuthorization('code', start.state), /expirou/);
    assert.equal(called, false);
  });

  it('recusa autorização sem o escopo de contatos sem expor os tokens', async () => {
    const accessToken = 'access-token-super-secreto';
    const provider = new GooglePeopleApiProvider(config, (async (input: string | URL | Request) => {
      if (String(input).includes('/token')) {
        return Response.json({
          access_token: accessToken,
          refresh_token: 'refresh-token-super-secreto',
          expires_in: 3600,
          scope: 'openid email profile',
        });
      }
      return Response.json({ sub: 'subject', email: 'user@example.com' });
    }) as typeof fetch);
    const start = await provider.createAuthorizationRequest();
    await assert.rejects(
      () => provider.finishAuthorization('code', start.state),
      (error: unknown) =>
        error instanceof Error &&
        /acesso aos contatos/.test(error.message) &&
        !error.message.includes(accessToken),
    );
  });
});

describe('GooglePeopleApiProvider contatos', () => {
  it('mapeia a resposta People API para o contrato do domínio', async () => {
    const provider = new GooglePeopleApiProvider(config, (async () =>
      Response.json({
        connections: [
          {
            resourceName: 'people/123',
            etag: 'etag-1',
            names: [{ displayName: 'Ana Silva', givenName: 'Ana', familyName: 'Silva' }],
            phoneNumbers: [
              { value: '+55 16 99999-1111', type: 'mobile', metadata: { primary: true } },
            ],
            organizations: [{ name: 'Empresa', title: 'Diretora', department: 'Vendas' }],
            memberships: [
              { contactGroupMembership: { contactGroupResourceName: 'contactGroups/myContacts' } },
            ],
            metadata: { deleted: false },
          },
        ],
        nextSyncToken: 'sync-token',
      })) as typeof fetch);
    const page = await provider.listContacts(
      { accessToken: 'access', scope: [] },
      { requestSyncToken: true, pageSize: 1000 },
    );
    assert.equal(page.nextSyncToken, 'sync-token');
    assert.equal(page.contacts[0]?.resourceName, 'people/123');
    assert.equal(page.contacts[0]?.phones[0]?.primary, true);
    assert.equal(page.contacts[0]?.organizationDepartment, 'Vendas');
    assert.equal(page.contacts[0]?.labels[0]?.resourceName, 'contactGroups/myContacts');
  });

  it('traduz EXPIRED_SYNC_TOKEN para erro específico', async () => {
    const provider = new GooglePeopleApiProvider(config, (async () =>
      Response.json(
        { error: { details: [{ reason: 'EXPIRED_SYNC_TOKEN' }] } },
        { status: 400 },
      )) as typeof fetch);
    await assert.rejects(
      () =>
        provider.listContacts(
          { accessToken: 'access', scope: [] },
          { requestSyncToken: false, pageSize: 1000, syncToken: 'expired' },
        ),
      GoogleSyncTokenExpiredError,
    );
  });

  it('rejeita resourceName fora do formato permitido antes da chamada HTTP', async () => {
    let called = false;
    const provider = new GooglePeopleApiProvider(config, (async () => {
      called = true;
      return Response.json({});
    }) as typeof fetch);
    await assert.rejects(
      () => provider.deleteContact({ accessToken: 'access', scope: [] }, '../contacts'),
      /inválido/,
    );
    assert.equal(called, false);
  });

  it('distingue contato já ausente durante a exclusão', async () => {
    const provider = new GooglePeopleApiProvider(
      config,
      (async () => new Response(null, { status: 404 })) as typeof fetch,
    );
    await assert.rejects(
      () => provider.deleteContact({ accessToken: 'access', scope: [] }, 'people/123'),
      GoogleContactNotFoundError,
    );
  });
});
