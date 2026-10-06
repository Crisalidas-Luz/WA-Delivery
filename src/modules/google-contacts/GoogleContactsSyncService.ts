import type { SettingsService } from '../settings/SettingsService.js';
import { normalizePhone } from '../contacts/phone.js';
import {
  GoogleSyncTokenExpiredError,
  type GooglePeopleProvider,
  type GoogleTokenSet,
} from '../../providers/google/GooglePeopleProvider.js';
import {
  GoogleContactsRepository,
  type NormalizedGooglePhone,
} from './GoogleContactsRepository.js';

export class GoogleContactsSyncService {
  public constructor(
    private readonly repository: GoogleContactsRepository,
    private readonly provider: GooglePeopleProvider,
    private readonly settings?: SettingsService,
  ) {}

  public async sync(
    tokens: GoogleTokenSet,
  ): Promise<{ created: number; updated: number; deleted: number }> {
    const state = this.repository.syncState();
    try {
      return await this.run(tokens, state?.syncToken);
    } catch (error) {
      if (error instanceof GoogleSyncTokenExpiredError && state?.syncToken) {
        this.repository.clearSyncToken();
        return this.run(tokens, undefined);
      }
      this.repository.failSync(
        'SYNC_FAILED',
        error instanceof Error ? error.message : 'Falha desconhecida.',
      );
      throw error;
    }
  }

  private async run(tokens: GoogleTokenSet, syncToken: string | undefined) {
    const type = syncToken ? 'incremental' : 'full';
    this.repository.beginSync(type);
    let pageToken: string | undefined;
    let nextSyncToken: string | undefined;
    const totals = { created: 0, updated: 0, deleted: 0 };
    do {
      const page = await this.provider.listContacts(tokens, {
        ...(pageToken ? { pageToken } : {}),
        ...(syncToken ? { syncToken } : {}),
        requestSyncToken: !syncToken,
        pageSize: 1000,
      });
      const counts = this.repository.applyPage(
        page.contacts.map((contact) => ({ contact, phones: this.normalizePhones(contact.phones) })),
      );
      totals.created += counts.created;
      totals.updated += counts.updated;
      totals.deleted += counts.deleted;
      pageToken = page.nextPageToken;
      nextSyncToken = page.nextSyncToken ?? nextSyncToken;
    } while (pageToken);
    this.repository.finishSync(type, nextSyncToken ?? syncToken, totals);
    return totals;
  }

  private normalizePhones(
    phones: Array<{ label: string; value: string; primary: boolean }>,
  ): NormalizedGooglePhone[] {
    return phones.map((phone) => {
      try {
        return {
          label: phone.label,
          rawValue: phone.value,
          normalizedPhone: normalizePhone(phone.value, this.settings?.getAll()),
          primary: phone.primary,
          valid: true,
        };
      } catch (error) {
        return {
          label: phone.label,
          rawValue: phone.value,
          primary: phone.primary,
          valid: false,
          validationReason: error instanceof Error ? error.message : 'Telefone inválido.',
        };
      }
    });
  }
}
