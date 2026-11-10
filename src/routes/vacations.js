import { requireAdminOrSession } from '../lib/security.js';
import { createVacations, listVacations } from '../services/vacationService.js';

const vacationSecurity = [{ AdminBearerAuth: [] }, { SessionCookie: [] }];

export default async function vacationRoutes(app) {
  app.get('/vacaciones', {
    preHandler: requireAdminOrSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Consultar vacaciones de usuarios o todas las vacaciones como administrador',
      description: 'El administrador puede filtrar por una lista de IDs en `usuarios`; si no se envía o está vacía, devuelve todas. Un usuario con sesión solo ve sus propias vacaciones.',
      security: vacationSecurity,
      querystring: {
        type: 'object',
        properties: {
          usuarios: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'IDs de usuario. Para administradores, lista vacía o ausente significa todos.' },
        },
      },
    },
  }, async (request) => {
    const userIds = request.isAdmin
      ? (request.query.usuarios || [])
      : [request.user.id];
    return { vacaciones: await listVacations(userIds) };
  });

  app.post('/vacaciones', {
    preHandler: requireAdminOrSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Registrar fechas de vacaciones',
      description: 'Acepta entre 1 y 366 fechas con formato YYYY-MM-DD. El administrador debe indicar usuarioId; un usuario crea fechas solo para sí mismo. Las fechas ya guardadas se ignoran.',
      security: vacationSecurity,
      body: {
        type: 'object',
        required: ['fechas'],
        properties: {
          usuarioId: { type: 'integer', minimum: 1 },
          fechas: {
            type: 'array',
            minItems: 1,
            maxItems: 366,
            items: { type: 'string', format: 'date' },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { fechas, usuarioId } = request.body || {};
    if (request.isAdmin && (!Number.isInteger(usuarioId) || usuarioId < 1)) {
      return reply.code(400).send({ error: 'El administrador debe indicar un usuarioId válido.' });
    }
    if (!request.isAdmin && usuarioId !== undefined) {
      return reply.code(403).send({ error: 'Solo el administrador puede indicar usuarioId.' });
    }
    try {
      const result = await createVacations(request.isAdmin ? usuarioId : request.user.id, fechas);
      if (result.invalid) {
        return reply.code(400).send({ error: 'fechas debe ser una lista de 1 a 366 fechas válidas con formato YYYY-MM-DD.' });
      }
      return reply.code(201).send({ guardadas: result.inserted.length, vacaciones: result.inserted });
    } catch (error) {
      if (error.code === '23503') {
        return reply.code(404).send({ error: 'Usuario no encontrado.' });
      }
      throw error;
    }
  });
}
