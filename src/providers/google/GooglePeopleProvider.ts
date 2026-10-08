export const GOOGLE_CONTACTS_SCOPE = 'https://www.googleapis.com/auth/contacts';
export const GOOGLE_IDENTITY_SCOPES = ['openid', 'email', 'profile'] as const;

export interface GoogleOAuthStart {
  authorizationUrl: string;
  state: string;
  expiresAt: string;
}

export interface GoogleAccountIdentity {
  subject: string;
  email: string;
  displayName: string;
}

export interface GoogleTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
  scope: string[];
}

export interface GoogleContactPhone {
  label: string;
  value: string;
  primary: boolean;
}

export interface GoogleContactRecord {
  resourceName: string;
  etag?: string;
  deleted: boolean;
  displayName: string;
  givenName: string;
  middleName: string;
  familyName: string;
  phoneticName: string;
  honorificPrefix: string;
  honorificSuffix: string;
  nickname: string;
  fileAs: string;
  organizationName: string;
  organizationTitle: string;
  organizationDepartment: string;
  birthday?: string;
  biography: string;
  phones: GoogleContactPhone[];
  labels: Array<{ resourceName: string; name: string }>;
  raw: Record<string, unknown>;
}

export interface GoogleContactsPage {
  contacts: GoogleContactRecord[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface ListGoogleContactsInput {
  pageToken?: string;
  syncToken?: string;
  requestSyncToken: boolean;
  pageSize: number;
}

export interface GooglePeopleProvider {
  createAuthorizationRequest(): Promise<GoogleOAuthStart>;
  finishAuthorization(
    code: string,
    state: string,
  ): Promise<{
    account: GoogleAccountIdentity;
    tokens: GoogleTokenSet;
  }>;
  refreshAccessToken(tokens: GoogleTokenSet): Promise<GoogleTokenSet>;
  revoke(tokens: GoogleTokenSet): Promise<void>;
  listContacts(tokens: GoogleTokenSet, input: ListGoogleContactsInput): Promise<GoogleContactsPage>;
  getContact(
    tokens: GoogleTokenSet,
    resourceName: string,
  ): Promise<GoogleContactRecord | undefined>;
  deleteContact(tokens: GoogleTokenSet, resourceName: string): Promise<void>;
}

export class GoogleSyncTokenExpiredError extends Error {
  public constructor() {
    super('O token de sincronização do Google expirou.');
    this.name = 'GoogleSyncTokenExpiredError';
  }
}

export class GoogleContactNotFoundError extends Error {
  public constructor() {
    super('O contato Google já não existe.');
    this.name = 'GoogleContactNotFoundError';
  }
}

export interface GoogleTokenStore {
  save(key: string, tokens: GoogleTokenSet): Promise<void>;
  load(key: string): Promise<GoogleTokenSet | undefined>;
  delete(key: string): Promise<void>;
}
