import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ContactSelectionService } from '../modules/contact-selection/ContactSelectionService.js';
import { ContactFilterValidationError } from '../modules/contact-selection/filterTypes.js';

export function registerContactSelectionRoutes(
  server: FastifyInstance,
  selection?: ContactSelectionService,
): void {
  server.post<{
    Body: { filter?: unknown; page?: number; pageSize?: number; order?: 'name' | 'google' };
  }>('/api/contacts/search', async (request, reply) => {
    if (!selection) return unavailable(reply);
    try {
      return selection.search({
        filter: request.body?.filter,
        ...(request.body?.page === undefined ? {} : { page: request.body.page }),
        ...(request.body?.pageSize === undefined ? {} : { pageSize: request.body.pageSize }),
        ...(request.body?.order === undefined ? {} : { order: request.body.order }),
      });
    } catch (error) {
      return selectionError(reply, error);
    }
  });

  server.get('/api/contact-filters', async (_request, reply) => {
    if (!selection) return unavailable(reply);
    return { items: selection.listSavedFilters() };
  });

  server.post<{ Body: { name?: string; definition?: unknown } }>(
    '/api/contact-filters',
    async (request, reply) => {
      if (!selection) return unavailable(reply);
      try {
        return reply.code(201).send(selection.saveFilter(request.body ?? {}));
      } catch (error) {
        return selectionError(reply, error);
      }
    },
  );

  server.put<{ Params: { id: string }; Body: { name?: string; definition?: unknown } }>(
    '/api/contact-filters/:id',
    async (request, reply) => {
      if (!selection) return unavailable(reply);
      const id = parseId(request.params.id);
      if (!id) return reply.code(400).send({ message: 'Identificador de filtro inválido.' });
      try {
        return selection.saveFilter({ id, ...request.body });
      } catch (error) {
        return selectionError(reply, error);
      }
    },
  );

  server.delete<{ Params: { id: string } }>('/api/contact-filters/:id', async (request, reply) => {
    if (!selection) return unavailable(reply);
    const id = parseId(request.params.id);
    if (!id) return reply.code(400).send({ message: 'Identificador de filtro inválido.' });
    return selection.deleteSavedFilter(id)
      ? reply.code(204).send()
      : reply.code(404).send({ message: 'Filtro salvo não encontrado.' });
  });
}

function parseId(value: string): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function unavailable(reply: FastifyReply) {
  return reply.code(503).send({ message: 'A busca da agenda local não está disponível.' });
}

function selectionError(reply: FastifyReply, error: unknown) {
  if (error instanceof ContactFilterValidationError) {
    return reply.code(422).send({ message: error.message, issues: error.issues });
  }
  const message = error instanceof Error ? error.message : 'Filtro inválido.';
  return reply.code(/não encontrado/i.test(message) ? 404 : 422).send({ message });
}
