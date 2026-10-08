import type { FastifyInstance } from 'fastify';
import type {
  ContactDeletionService,
  CreateContactDeletionJobInput,
} from '../modules/contact-deletion/ContactDeletionService.js';

export function registerContactDeletionRoutes(
  server: FastifyInstance,
  service?: ContactDeletionService,
): void {
  server.post<{ Params: { id: string }; Body: CreateContactDeletionJobInput }>(
    '/api/campaigns/:id/deletion-jobs',
    async (request, reply) => {
      if (!service)
        return reply.code(503).send({ message: 'Configure e conecte o Google Contacts primeiro.' });
      const id = parseId(request.params.id);
      if (!id) return reply.code(400).send({ message: 'Identificador da campanha inválido.' });
      return reply.code(202).send(service.createAndStart(id, request.body ?? {}));
    },
  );

  server.get<{ Params: { id: string } }>(
    '/api/campaigns/:id/deletion-jobs/latest',
    async (request, reply) => {
      if (!service)
        return reply.code(503).send({ message: 'Configure e conecte o Google Contacts primeiro.' });
      const id = parseId(request.params.id);
      if (!id) return reply.code(400).send({ message: 'Identificador da campanha inválido.' });
      return (
        service.findLatestForCampaign(id) ??
        reply.code(404).send({ message: 'Nenhum job de exclusão foi criado para esta campanha.' })
      );
    },
  );

  server.get<{ Params: { id: string } }>(
    '/api/contact-deletion-jobs/:id',
    async (request, reply) => {
      if (!service)
        return reply.code(503).send({ message: 'Configure e conecte o Google Contacts primeiro.' });
      const id = parseId(request.params.id);
      if (!id) return reply.code(400).send({ message: 'Identificador do job inválido.' });
      return (
        service.find(id) ?? reply.code(404).send({ message: 'Job de exclusão não encontrado.' })
      );
    },
  );

  server.post<{ Params: { id: string } }>(
    '/api/contact-deletion-jobs/:id/retry',
    async (request, reply) => {
      if (!service)
        return reply.code(503).send({ message: 'Configure e conecte o Google Contacts primeiro.' });
      const id = parseId(request.params.id);
      if (!id) return reply.code(400).send({ message: 'Identificador do job inválido.' });
      return (
        service.retryAndStart(id) ??
        reply.code(404).send({ message: 'Job de exclusão não encontrado.' })
      );
    },
  );
}

function parseId(value: string): number | undefined {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}
