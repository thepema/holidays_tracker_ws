import { appError } from '../../shared/errors.js';
import { requireAdmin, requireAdminOrSession } from '../../shared/security.js';
import {
  createVacations,
  deleteVacation,
  listVacationYears,
  listVacations,
  updateVacationDate,
} from './vacations.service.js';
import { listAuthenticatedUsers } from '../users/users.service.js';
import { sendVacationReminderToAuthenticatedUsers } from '../auth/session.service.js';

const vacationSecurity = [{ AdminBearerAuth: [] }, { SessionCookie: [] }];
const adminOnlySecurity = [{ AdminBearerAuth: [] }];

export default async function vacationsRoutes(app) {
  app.get('/vacaciones/anios', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Obtener años con días de vacaciones registrados (administrador)',
      security: adminOnlySecurity,
    },
  }, async () => {
    return {
      anios: await listVacationYears(),
    };
  });

  app.get('/vacaciones', {
    preHandler: requireAdminOrSession,
    schema: {
      tags: ['Vacaciones'],
      summary: 'Consultar vacaciones de usuarios o filtradas como administrador',
      description: 'El administrador puede filtrar por `usuarios`, `anio`, `mes`, `equipoId` y `oficinaId`. Un usuario con sesión solo ve sus propias vacaciones.',
      security: vacationSecurity,
      querystring: {
        type: 'object',
        properties: {
          usuarios: { type: 'array', items: { type: 'integer', minimum: 1 }, description: 'IDs de usuario. Para administradores, lista vacía o ausente significa todos.' },
          anio: { type: 'integer', minimum: 1900, maximum: 2200, description: 'Año opcional para filtrar las vacaciones (YYYY).' },
          mes: { type: 'integer', minimum: 1, maximum: 12, description: 'Mes opcional para filtrar las vacaciones (1-12).' },
          equipoId: { type: 'integer', minimum: 1, description: 'ID de equipo opcional para filtrar las vacaciones de los miembros de ese equipo.' },
          oficinaId: { type: 'integer', minimum: 1, description: 'ID de oficina opcional para filtrar las vacaciones de los usuarios de esa oficina.' },
        },
      },
    },
  }, async (request) => {
    const userIds = request.isAdmin
      ? (request.query.usuarios || [])
      : [request.user.id];
    const { anio, mes, equipoId, oficinaId } = request.query || {};
    return {
      vacaciones: await listVacations(userIds, {
        anio,
        mes,
        equipoId: request.isAdmin ? equipoId : null,
        oficinaId: request.isAdmin ? oficinaId : null,
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
      throw appError('VACATION_ADMIN_USER_ID_REQUIRED');
    }
    if (!request.isAdmin && usuarioId !== undefined && Number(usuarioId) !== Number(request.user.id)) {
      throw appError('VACATION_OTHER_USER_FORBIDDEN');
    }
    const result = await createVacations(request.isAdmin ? usuarioId : request.user.id, fechas);
    return reply.code(201).send({ guardadas: result.inserted.length, vacaciones: result.inserted });
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
  }, async (request) => {
    const { vacacionId } = request.params;
    const { fecha } = request.body || {};
    const result = await updateVacationDate(
      vacacionId,
      request.user?.id,
      fecha,
      request.isAdmin
    );
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
  }, async (request) => {
    const { vacacionId } = request.params;
    const result = await deleteVacation(
      vacacionId,
      request.user?.id,
      request.isAdmin
    );
    return { eliminado: true, id: result.id };
  });

  app.post('/vacaciones/recordatorio', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Enviar recordatorio de registro de vacaciones a usuarios autenticados',
      description: 'Envía un correo electrónico a todos los usuarios con sesión autorizada activa recordándoles entrar en la aplicación y registrar sus vacaciones previstas para los próximos meses.',
      security: adminOnlySecurity,
    },
  }, async () => {
    const users = await listAuthenticatedUsers();
    const result = await sendVacationReminderToAuthenticatedUsers(users);
    return {
      total: users.length,
      enviadas: result.sent,
      fallidas: result.failed,
    };
  });
}
