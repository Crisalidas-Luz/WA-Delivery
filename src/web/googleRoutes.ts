import type { FastifyInstance } from 'fastify';
import type { GoogleAuthService } from '../modules/google-auth/GoogleAuthService.js';

export function registerGoogleRoutes(server: FastifyInstance, google?: GoogleAuthService): void {
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
    return reply.code(202).send(await google.synchronize());
  });

  server.post('/api/google/disconnect', async (_request, reply) => {
    if (!google) return notConfigured(reply);
    await google.disconnect();
    return reply.code(204).send();
  });
}

function notConfigured(reply: import('fastify').FastifyReply) {
  return reply.code(503).send({
    message: 'Configure GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET para conectar o Google Contacts.',
  });
}
