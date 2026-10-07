import {
  ContactSelectionRepository,
  type ContactSearchInput,
  type ContactSearchItem,
  type ContactSearchResult,
  type SavedContactFilter,
} from './ContactSelectionRepository.js';
import { validateContactFilter } from './filterTypes.js';

export interface ContactSelectionDefinition {
  version: 1;
  filter: unknown;
  selectAllMatching: boolean;
  includedIds: number[];
  excludedIds: number[];
  order: 'name' | 'google';
}

export interface ResolvedContactSelection {
  definition: ContactSelectionDefinition;
  contactIds: number[];
  summary: {
    selected: number;
    eligible: number;
    missingPhone: number;
    invalidPhone: number;
    duplicatePhone: number;
    optedOut: number;
  };
}

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

  public resolveSelection(input: {
    filter?: unknown;
    selectAllMatching?: boolean;
    includedIds?: unknown;
    excludedIds?: unknown;
    order?: 'name' | 'google';
  }): ResolvedContactSelection {
    const filter = validateContactFilter(input.filter);
    const includedIds = validIds(input.includedIds);
    const excludedIds = new Set(validIds(input.excludedIds));
    const selected = new Map<number, ContactSearchItem>();
    if (input.selectAllMatching === true) {
      let page = 1;
      let result;
      do {
        result = this.repository.search({
          filter,
          page,
          pageSize: 100,
          order: input.order ?? 'name',
        });
        for (const item of result.items) selected.set(item.id, item);
        page += 1;
      } while (selected.size < result.total);
    }
    if (includedIds.length > 0) {
      for (const item of this.repository.searchByIds(includedIds)) selected.set(item.id, item);
    }
    for (const id of excludedIds) selected.delete(id);
    const items = [...selected.values()].sort(
      input.order === 'google'
        ? (left, right) => left.id - right.id
        : (left, right) =>
            left.displayName.localeCompare(right.displayName, 'pt-BR', { sensitivity: 'base' }) ||
            left.id - right.id,
    );
    const summary = {
      selected: items.length,
      eligible: 0,
      missingPhone: 0,
      invalidPhone: 0,
      duplicatePhone: 0,
      optedOut: 0,
    };
    const selectedPhones = new Set<string>();
    for (const item of items) {
      if (item.optedOut) summary.optedOut += 1;
      else if (!item.phone) summary.missingPhone += 1;
      else if (!item.phoneValid) summary.invalidPhone += 1;
      else if (selectedPhones.has(item.phone)) summary.duplicatePhone += 1;
      else {
        selectedPhones.add(item.phone);
        summary.eligible += 1;
      }
    }
    return {
      definition: {
        version: 1,
        filter,
        selectAllMatching: input.selectAllMatching === true,
        includedIds,
        excludedIds: [...excludedIds],
        order: input.order ?? 'name',
      },
      contactIds: items.map((item) => item.id),
      summary,
    };
  }
}

function validIds(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const ids = value.filter((id): id is number => Number.isSafeInteger(id) && id > 0);
  if (ids.length > 10_000) throw new Error('A seleção manual excede o limite de 10.000 contatos.');
  return [...new Set(ids)];
}
