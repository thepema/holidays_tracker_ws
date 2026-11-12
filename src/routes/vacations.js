import { requireAdminOrSession } from '../lib/security.js';
import {
  createVacations,
  deleteVacation,
  listVacations,
  updateVacationDate,
} from '../services/vacationService.js';

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
          anio: { type: 'integer', minimum: 1900, maximum: 2200, description: 'Año opcional para filtrar las vacaciones (YYYY).' },
          mes: { type: 'integer', minimum: 1, maximum: 12, description: 'Mes opcional para filtrar las vacaciones (1-12).' },
          equipoId: { type: 'integer', minimum: 1, description: 'ID de equipo opcional para filtrar las vacaciones de los miembros de ese equipo.' },
        },
      },
    },
  }, async (request) => {
    const userIds = request.isAdmin
      ? (request.query.usuarios || [])
      : [request.user.id];
    const { anio, mes, equipoId } = request.query || {};
    return {
      vacaciones: await listVacations(userIds, {
        anio,
        mes,
        equipoId: request.isAdmin ? equipoId : null,
      }),
    };
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
    if (!request.isAdmin && usuarioId !== undefined && Number(usuarioId) !== Number(request.user.id)) {
      return reply.code(403).send({ error: 'Solo el administrador puede indicar otro usuarioId.' });
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

  app.patch('/vacaciones/:vacacionId', {
    preHandler: requireAdminOrSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Modificar la fecha de un día de vacaciones (si aún no ha pasado)',
      security: vacationSecurity,
      params: {
        type: 'object',
        required: ['vacacionId'],
        properties: { vacacionId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        required: ['fecha'],
        properties: {
          fecha: { type: 'string', format: 'date' },
        },
      },
    },
  }, async (request, reply) => {
    const { vacacionId } = request.params;
    const { fecha } = request.body || {};
    const result = await updateVacationDate(
      vacacionId,
      request.user?.id,
      fecha,
      request.isAdmin
    );

    if (result.invalid) {
      return reply.code(400).send({ error: 'La nueva fecha debe tener formato válido YYYY-MM-DD.' });
    }
    if (result.pastTargetDate) {
      return reply.code(400).send({ error: 'No puedes cambiar un día de vacaciones a una fecha que ya ha pasado.' });
    }
    if (result.notFound) {
      return reply.code(404).send({ error: 'Día de vacaciones no encontrado.' });
    }
    if (result.forbidden) {
      return reply.code(403).send({ error: 'No tienes permiso para modificar este día de vacaciones.' });
    }
    if (result.pastDate) {
      return reply.code(400).send({ error: 'No se pueden modificar días de vacaciones cuya fecha ya ha pasado.' });
    }
    if (result.duplicate) {
      return reply.code(409).send({ error: 'Ya tienes registrado ese día de vacaciones.' });
    }
    return { vacacion: result.updated };
  });

  app.delete('/vacaciones/:vacacionId', {
    preHandler: requireAdminOrSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Eliminar / cancelar un día de vacaciones (si aún no ha pasado)',
      security: vacationSecurity,
      params: {
        type: 'object',
        required: ['vacacionId'],
        properties: { vacacionId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { vacacionId } = request.params;
    const result = await deleteVacation(
      vacacionId,
      request.user?.id,
      request.isAdmin
    );

    if (result.notFound) {
      return reply.code(404).send({ error: 'Día de vacaciones no encontrado.' });
    }
    if (result.forbidden) {
      return reply.code(403).send({ error: 'No tienes permiso para eliminar este día de vacaciones.' });
    }
    if (result.pastDate) {
      return reply.code(400).send({ error: 'No se pueden eliminar días de vacaciones cuya fecha ya ha pasado.' });
    }
    return { eliminado: true, id: result.id };
  });
}
