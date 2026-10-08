import type { FastifyInstance } from 'fastify';
import type { GoogleAuthService } from '../modules/google-auth/GoogleAuthService.js';
import type { GoogleOAuthConfigService } from '../modules/google-auth/GoogleOAuthConfigService.js';

export function registerGoogleRoutes(
  server: FastifyInstance,
  google?: GoogleAuthService,
  config?: GoogleOAuthConfigService,
): void {
  server.get('/api/google/config', async (_request, reply) => {
    if (!config) return reply.code(503).send({ message: 'Configuração Google indisponível.' });
    return config.status();
  });

  server.put<{ Body: { clientId?: unknown; clientSecret?: unknown } }>(
    '/api/google/config',
    async (request, reply) => {
      if (!config) return reply.code(503).send({ message: 'Configuração Google indisponível.' });
      if (google && (await google.status()).connected) {
        return reply.code(409).send({
          message: 'Desconecte a conta Google antes de trocar as credenciais OAuth.',
        });
      }
      if (
        typeof request.body?.clientId !== 'string' ||
        typeof request.body?.clientSecret !== 'string'
      ) {
        return reply.code(422).send({ message: 'Client ID e Client secret são obrigatórios.' });
      }
      await config.save(request.body.clientId, request.body.clientSecret);
      return reply.code(200).send({ ...(await config.status()), restartRequired: true });
    },
  );

  server.delete('/api/google/config', async (_request, reply) => {
    if (!config) return reply.code(503).send({ message: 'Configuração Google indisponível.' });
    if (google && (await google.status()).connected) {
      return reply
        .code(409)
        .send({ message: 'Desconecte a conta Google antes de apagar as credenciais.' });
    }
    await config.delete();
    return reply.code(204).send();
  });

  server.get('/api/google/status', async () => {
    if (!google)
      return {
        configured: false,
        connected: false,
        sync: { status: 'idle', created: 0, updated: 0, deleted: 0 },
      };
    return google.status();
  });

  server.post('/api/google/oauth/start', async (_request, reply) => {
    if (!google) return notConfigured(reply);
    return reply.code(202).send(await google.startAuthorization());
  });

  server.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/api/google/oauth/callback',
    async (request, reply) => {
      if (!google) return notConfigured(reply);
      if (request.query.error) {
        return reply.code(400).send({ message: 'O login Google foi cancelado ou recusado.' });
      }
      if (!request.query.code || !request.query.state) {
        return reply.code(400).send({ message: 'Callback OAuth incompleto.' });
      }
      await google.finishAuthorization(request.query.code, request.query.state);
      return reply.redirect('/settings.html?google=connected');
    },
  );

  server.post('/api/google/sync', async (_request, reply) => {
    if (!google) return notConfigured(reply);
    return reply.code(202).send(await google.startSynchronization());
  });

  server.get('/api/google/sync/status', async (_request, reply) => {
    if (!google) return notConfigured(reply);
    return (await google.status()).sync;
  });

  server.post('/api/google/disconnect', async (_request, reply) => {
    if (!google) return notConfigured(reply);
    await google.disconnect();
    return reply.code(204).send();
  });
}

function notConfigured(reply: import('fastify').FastifyReply) {
  return reply.code(503).send({
    message: 'Salve as credenciais OAuth do Google nas Configurações e reinicie o WA-Delivery.',
  });
}
