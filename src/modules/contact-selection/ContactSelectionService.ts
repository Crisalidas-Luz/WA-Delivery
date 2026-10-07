import {
  ContactSelectionRepository,
  type ContactSearchInput,
  type ContactSearchResult,
  type SavedContactFilter,
} from './ContactSelectionRepository.js';
import { validateContactFilter } from './filterTypes.js';

export class ContactSelectionService {
  public constructor(private readonly repository: ContactSelectionRepository) {}

  public search(input: ContactSearchInput): ContactSearchResult {
    return this.repository.search(input);
  }

  public listSavedFilters(): SavedContactFilter[] {
    return this.repository.listSavedFilters();
  }

  public saveFilter(input: {
    id?: number;
    name?: string;
    definition?: unknown;
  }): SavedContactFilter {
    const name = input.name?.trim() ?? '';
    if (!name || name.length > 100)
      throw new Error('Informe um nome de filtro com até 100 caracteres.');
    const definition = validateContactFilter(input.definition);
    return this.repository.saveFilter(name, definition, input.id);
  }

  public deleteSavedFilter(id: number): boolean {
    return this.repository.deleteSavedFilter(id);
  }
}
