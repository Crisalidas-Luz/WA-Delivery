import { createHash, randomBytes } from 'node:crypto';
import {
  GoogleContactNotFoundError,
  GOOGLE_CONTACTS_SCOPE,
  GOOGLE_IDENTITY_SCOPES,
  GoogleSyncTokenExpiredError,
  type GoogleAccountIdentity,
  type GoogleContactRecord,
  type GoogleContactsPage,
  type GoogleOAuthStart,
  type GooglePeopleProvider,
  type GoogleTokenSet,
  type ListGoogleContactsInput,
} from '../GooglePeopleProvider.js';

export interface GooglePeopleApiConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  authorizationTtlMs?: number;
}

interface PendingAuthorization {
  verifier: string;
  expiresAt: number;
}

type Fetch = typeof fetch;

export class GooglePeopleApiProvider implements GooglePeopleProvider {
  private readonly pending = new Map<string, PendingAuthorization>();
  private readonly authorizationTtlMs: number;

  public constructor(
    private readonly config: GooglePeopleApiConfig,
    private readonly fetchImpl: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {
    if (!config.clientId.trim() || !config.clientSecret.trim()) {
      throw new Error('Configure o client ID e client secret do Google OAuth.');
    }
    this.authorizationTtlMs = config.authorizationTtlMs ?? 10 * 60 * 1000;
  }

  public async createAuthorizationRequest(): Promise<GoogleOAuthStart> {
    this.removeExpiredStates();
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const expiresAt = this.now() + this.authorizationTtlMs;
    this.pending.set(state, { verifier, expiresAt });
    const params = new URLSearchParams({
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      response_type: 'code',
      scope: [GOOGLE_CONTACTS_SCOPE, ...GOOGLE_IDENTITY_SCOPES].join(' '),
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    return {
      authorizationUrl: `https://accounts.google.com/o/oauth2/v2/auth?${params}`,
      state,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  public async finishAuthorization(code: string, state: string) {
    const pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.expiresAt < this.now()) {
      throw new Error('A tentativa de login Google expirou ou é inválida.');
    }
    if (!code.trim()) throw new Error('O Google não retornou o código de autorização.');
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        code,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uri: this.config.redirectUri,
        grant_type: 'authorization_code',
        code_verifier: pending.verifier,
      }),
    });
    const body = await jsonResponse(response, 'Não foi possível concluir o login Google.');
    const tokens = tokenSet(body, this.now());
    assertContactsScope(tokens.scope);
    const account = await this.loadIdentity(tokens.accessToken);
    return { account, tokens };
  }

  public async refreshAccessToken(tokens: GoogleTokenSet): Promise<GoogleTokenSet> {
    if (!tokens.refreshToken) throw new Error('A sessão Google não possui refresh token.');
    const response = await this.fetchImpl('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: tokens.refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        grant_type: 'refresh_token',
      }),
    });
    const body = await jsonResponse(response, 'Não foi possível renovar a sessão Google.');
    const refreshed = tokenSet(body, this.now());
    const scope = refreshed.scope.length > 0 ? refreshed.scope : tokens.scope;
    assertContactsScope(scope);
    return { ...refreshed, refreshToken: tokens.refreshToken, scope };
  }

  public async revoke(tokens: GoogleTokenSet): Promise<void> {
    const token = tokens.refreshToken ?? tokens.accessToken;
    const response = await this.fetchImpl(
      `https://oauth2.googleapis.com/revoke?${new URLSearchParams({ token })}`,
      { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' } },
    );
    if (!response.ok) throw new Error('Não foi possível revogar a sessão Google.');
  }

  public async listContacts(
    tokens: GoogleTokenSet,
    input: ListGoogleContactsInput,
  ): Promise<GoogleContactsPage> {
    const params = new URLSearchParams({
      personFields:
        'metadata,names,nicknames,phoneNumbers,emailAddresses,organizations,birthdays,biographies,memberships,addresses,relations,urls,userDefined',
      sources: 'READ_SOURCE_TYPE_CONTACT',
      pageSize: String(input.pageSize),
      requestSyncToken: String(input.requestSyncToken),
    });
    if (input.pageToken) params.set('pageToken', input.pageToken);
    if (input.syncToken) params.set('syncToken', input.syncToken);
    const response = await this.authorizedFetch(
      tokens,
      `https://people.googleapis.com/v1/people/me/connections?${params}`,
    );
    const body = await readJson(response);
    if (!response.ok) {
      if (hasExpiredSyncToken(body)) throw new GoogleSyncTokenExpiredError();
      throw new Error(`Falha ao sincronizar Google Contacts (HTTP ${response.status}).`);
    }
    const data = body as Record<string, unknown>;
    const connections = Array.isArray(data.connections) ? data.connections : [];
    return {
      contacts: connections.map(toContactRecord),
      ...(typeof data.nextPageToken === 'string' ? { nextPageToken: data.nextPageToken } : {}),
      ...(typeof data.nextSyncToken === 'string' ? { nextSyncToken: data.nextSyncToken } : {}),
    };
  }

  public async getContact(
    tokens: GoogleTokenSet,
    resourceName: string,
  ): Promise<GoogleContactRecord | undefined> {
    assertResourceName(resourceName);
    const params = new URLSearchParams({
      personFields:
        'metadata,names,nicknames,phoneNumbers,emailAddresses,organizations,birthdays,biographies,memberships,addresses,relations,urls,userDefined',
    });
    const response = await this.authorizedFetch(
      tokens,
      `https://people.googleapis.com/v1/${resourceName}?${params}`,
    );
    if (response.status === 404) return undefined;
    return toContactRecord(
      await jsonResponse(response, 'Não foi possível consultar o contato Google.'),
    );
  }

  public async deleteContact(tokens: GoogleTokenSet, resourceName: string): Promise<void> {
    assertResourceName(resourceName);
    const response = await this.authorizedFetch(
      tokens,
      `https://people.googleapis.com/v1/${resourceName}:deleteContact`,
      { method: 'DELETE' },
    );
    if (response.status === 404) throw new GoogleContactNotFoundError();
    if (!response.ok) {
      throw new Error(`Não foi possível excluir o contato Google (HTTP ${response.status}).`);
    }
  }

  private async loadIdentity(accessToken: string): Promise<GoogleAccountIdentity> {
    const response = await this.fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const body = await jsonResponse(response, 'Não foi possível identificar a conta Google.');
    return {
      subject: requiredString(body, 'sub'),
      email: requiredString(body, 'email'),
      displayName: typeof body.name === 'string' ? body.name : requiredString(body, 'email'),
    };
  }

  private authorizedFetch(tokens: GoogleTokenSet, url: string, init: RequestInit = {}) {
    return this.fetchImpl(url, {
      ...init,
      headers: { ...init.headers, authorization: `Bearer ${tokens.accessToken}` },
    });
  }

  private removeExpiredStates(): void {
    for (const [state, pending] of this.pending) {
      if (pending.expiresAt < this.now()) this.pending.delete(state);
    }
  }
}

function tokenSet(body: Record<string, unknown>, nowMs: number): GoogleTokenSet {
  const accessToken = requiredString(body, 'access_token');
  const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : undefined;
  return {
    accessToken,
    ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
    ...(expiresIn ? { expiresAt: new Date(nowMs + expiresIn * 1000).toISOString() } : {}),
    scope: typeof body.scope === 'string' ? body.scope.split(/\s+/).filter(Boolean) : [],
  };
}

function assertContactsScope(scope: string[]): void {
  if (!scope.includes(GOOGLE_CONTACTS_SCOPE)) {
    throw new Error(
      'A autorização Google não concedeu acesso aos contatos. Tente conectar novamente.',
    );
  }
}

async function jsonResponse(response: Response, message: string): Promise<Record<string, unknown>> {
  const body = await readJson(response);
  if (!response.ok || typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error(`${message} (HTTP ${response.status})`);
  }
  return body as Record<string, unknown>;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return {};
  }
}

function requiredString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || !value) throw new Error(`Resposta Google sem o campo ${key}.`);
  return value;
}

function assertResourceName(value: string): void {
  if (!/^people\/[A-Za-z0-9_-]+$/.test(value))
    throw new Error('Identificador de contato Google inválido.');
}

function hasExpiredSyncToken(body: unknown): boolean {
  return JSON.stringify(body).includes('EXPIRED_SYNC_TOKEN');
}

function toContactRecord(value: unknown): GoogleContactRecord {
  const person = asRecord(value);
  const name = firstRecord(person.names);
  const organization = firstRecord(person.organizations);
  const birthday = firstRecord(person.birthdays)?.date;
  const birthdayRecord = asRecord(birthday);
  const memberships = arrayRecords(person.memberships);
  return {
    resourceName: requiredString(person, 'resourceName'),
    ...(typeof person.etag === 'string' ? { etag: person.etag } : {}),
    deleted: asRecord(person.metadata).deleted === true,
    displayName: stringValue(name?.displayName),
    givenName: stringValue(name?.givenName),
    middleName: stringValue(name?.middleName),
    familyName: stringValue(name?.familyName),
    phoneticName: stringValue(name?.phoneticFullName),
    honorificPrefix: stringValue(name?.honorificPrefix),
    honorificSuffix: stringValue(name?.honorificSuffix),
    nickname: stringValue(firstRecord(person.nicknames)?.value),
    fileAs: '',
    organizationName: stringValue(organization?.name),
    organizationTitle: stringValue(organization?.title),
    organizationDepartment: stringValue(organization?.department),
    ...(Object.keys(birthdayRecord).length
      ? {
          birthday: [birthdayRecord.year, birthdayRecord.month, birthdayRecord.day]
            .filter(Boolean)
            .join('-'),
        }
      : {}),
    biography: stringValue(firstRecord(person.biographies)?.value),
    phones: arrayRecords(person.phoneNumbers).map((phone) => ({
      label: stringValue(phone.formattedType ?? phone.type),
      value: stringValue(phone.value),
      primary: asRecord(phone.metadata).primary === true,
    })),
    labels: memberships
      .map((membership) => asRecord(membership.contactGroupMembership).contactGroupResourceName)
      .filter((item): item is string => typeof item === 'string')
      .map((resourceName) => ({
        resourceName,
        name: resourceName.split('/').at(-1) ?? resourceName,
      })),
    raw: person,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function arrayRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord) : [];
}

function firstRecord(value: unknown): Record<string, unknown> | undefined {
  return arrayRecords(value)[0];
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
