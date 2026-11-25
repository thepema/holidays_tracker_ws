import { createRateLimitPreHandler } from '../lib/rateLimiter.js';
import { requireAdmin, createAdminToken, verifyAdminPassword, ADMIN_TOKEN_TTL_SECONDS } from '../lib/security.js';
import {
  createUser,
  findUserById,
  getAdminSessionsSummary,
  listAuthenticatedUsers,
  listNonAdminUsers,
  listUsersWithPendingInvitation,
  listUsersWithoutActiveSession,
  updateUser,
} from '../services/userService.js';
import {
  createTeam,
  deleteTeam,
  listTeams,
  setUserTeams,
  updateTeam,
} from '../services/teamService.js';
import {
  addOfficeHoliday,
  createOffice,
  createOfficeCalendar,
  deleteOffice,
  deleteOfficeCalendar,
  deleteOfficeHoliday,
  listOffices,
  updateOffice,
} from '../services/officeService.js';
import {
  inviteUsersWithoutActiveSession,
  issueInvitation,
  sendVacationReminderToAuthenticatedUsers,
} from '../services/sessionService.js';

const adminSecurity = [{ AdminBearerAuth: [] }];

const adminLoginRateLimit = createRateLimitPreHandler({
  bucket: 'route:admin:login',
  maxRequests: 8,
  windowMs: 15 * 60 * 1000,
  errorMessage: 'Demasiados intentos de inicio de sesión de administrador.',
});

export default async function adminRoutes(app) {
  app.post('/admin/login', {
    preHandler: adminLoginRateLimit,
    schema: {
      tags: ['Administración'],
      summary: 'Iniciar sesión como administrador',
      description: 'Intercambia ADMIN_PASSWORD por un token Bearer válido durante 8 horas.',
      body: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string', minLength: 1 } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            tokenType: { type: 'string' },
            expiresIn: { type: 'integer' },
          },
          required: ['token', 'tokenType', 'expiresIn'],
        },
        401: {
          type: 'object',
          properties: { error: { type: 'string' } },
          required: ['error'],
        },
      },
    },
  }, async (request, reply) => {
    if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_TOKEN_SECRET) {
      return reply.code(503).send({ error: 'La autenticación de administración no está configurada.' });
    }

    const { password } = request.body || {};
    if (!verifyAdminPassword(password)) {
      return reply.code(401).send({ error: 'Credenciales de administrador no válidas.' });
    }

    return {
      token: createAdminToken(),
      tokenType: 'Bearer',
      expiresIn: ADMIN_TOKEN_TTL_SECONDS,
    };
  });

  app.get('/usuarios', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Obtener usuarios (excluyendo administrador)',
      description: 'Devuelve todos los usuarios cuyo cargo no sea de administrador junto con sus equipos asignados. Requiere un token Bearer obtenido en /api/admin/login.',
      security: adminSecurity,
    },
  }, async () => {
    const usuarios = await listNonAdminUsers();
    return { usuarios };
  });

  app.get('/usuarios/pendientes', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Obtener usuarios con invitación enviada pendiente de activar',
      description: 'Devuelve todos los datos de los usuarios a los que se les ha enviado la invitación (estado `proceso`) y aún no han completado la autenticación.',
      security: adminSecurity,
    },
  }, async () => {
    const usuarios = await listUsersWithPendingInvitation();
    return { usuarios };
  });

  app.get('/sesiones/resumen', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Obtener resumen de sesiones de usuarios (pendientes, solicitados y autenticados)',
      description: 'Devuelve desde servidor los listados de usuarios con invitación pendiente (`proceso`), solicitudes de reseteo (`solicitado`) y los contadores totales incluyendo usuarios autenticados (`autorizado`).',
      security: adminSecurity,
    },
  }, async () => {
    return getAdminSessionsSummary();
  });

  app.post('/usuarios', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Crear usuario',
      description: 'Requiere un token Bearer obtenido en /api/admin/login.',
      security: adminSecurity,
      body: {
        type: 'object',
        required: ['codigo', 'nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'],
        properties: {
          codigo: { type: 'string' },
          nombre: { type: 'string' },
          apellidos: { type: 'string' },
          cargo: { type: 'string' },
          email: { type: 'string', format: 'email' },
          tipo_vacaciones: { type: 'string' },
          oficinaId: { type: ['integer', 'null'], minimum: 1 },
          oficina_id: { type: ['integer', 'null'], minimum: 1 },
          equipoIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          equipo_ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
          equipos: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const input = request.body || {};
    const required = ['codigo', 'nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'];
    if (required.some((key) => typeof input[key] !== 'string' || !input[key].trim())) {
      return reply.code(400).send({ error: `Se requieren estos campos: ${required.join(', ')}.` });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
      return reply.code(400).send({ error: 'El email no tiene un formato válido.' });
    }
    try {
      const user = await createUser(input);
      return reply.code(201).send({ usuario: user });
    } catch (error) {
      if (error.code === '23505') {
        const isCodeConflict = String(error.constraint || error.detail || '').toLowerCase().includes('codigo');
        return reply.code(409).send({
          error: isCodeConflict ? 'Ya existe un usuario con ese código.' : 'Ya existe un usuario con ese email.',
        });
      }
      if (error.code === '23503') return reply.code(400).send({ error: 'La oficina seleccionada no existe.' });
      if (error.code === '23514') return reply.code(400).send({ error: 'Los datos del usuario no son válidos.' });
      throw error;
    }
  });

  app.patch('/usuarios/:usuarioId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Editar usuario',
      description: 'Permite actualizar parcialmente los datos y equipos de un usuario. Requiere token Bearer de administrador.',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['usuarioId'],
        properties: { usuarioId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        minProperties: 1,
        additionalProperties: false,
        properties: {
          codigo: { type: 'string' },
          nombre: { type: 'string' },
          apellidos: { type: 'string' },
          cargo: { type: 'string' },
          email: { type: 'string', format: 'email' },
          tipo_vacaciones: { type: 'string' },
          oficinaId: { type: ['integer', 'null'], minimum: 1 },
          oficina_id: { type: ['integer', 'null'], minimum: 1 },
          equipoIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          equipo_ids: { type: 'array', items: { type: 'integer', minimum: 1 } },
          equipos: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const { usuarioId } = request.params;
    const existing = await findUserById(usuarioId);
    if (!existing) {
      return reply.code(404).send({ error: 'Usuario no encontrado.' });
    }

    const updates = request.body || {};
    const stringKeys = ['codigo', 'nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'];
    for (const key of stringKeys) {
      if (updates[key] !== undefined && (typeof updates[key] !== 'string' || !updates[key].trim())) {
        return reply.code(400).send({ error: `El campo ${key} no puede estar vacío.` });
      }
    }

    if (updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email.trim())) {
      return reply.code(400).send({ error: 'El email no tiene un formato válido.' });
    }

    try {
      const updatedUser = await updateUser(usuarioId, updates);
      return { usuario: updatedUser };
    } catch (error) {
      if (error.code === '23505') {
        const isCodeConflict = String(error.constraint || error.detail || '').toLowerCase().includes('codigo');
        return reply.code(409).send({
          error: isCodeConflict ? 'Ya existe un usuario con ese código.' : 'Ya existe un usuario con ese email.',
        });
      }
      if (error.code === '23503') return reply.code(400).send({ error: 'La oficina seleccionada no existe.' });
      if (error.code === '23514') return reply.code(400).send({ error: 'Los datos del usuario no son válidos.' });
      throw error;
    }
  });

  app.put('/usuarios/:usuarioId/equipos', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Asignar equipos a un usuario',
      description: 'Reemplaza la lista de equipos a los que pertenece un usuario.',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['usuarioId'],
        properties: { usuarioId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        properties: {
          equipoIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
          equipos: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const { usuarioId } = request.params;
    const existing = await findUserById(usuarioId);
    if (!existing) {
      return reply.code(404).send({ error: 'Usuario no encontrado.' });
    }
    const body = request.body || {};
    const rawIds = Array.isArray(body.equipoIds)
      ? body.equipoIds
      : Array.isArray(body.equipos)
        ? body.equipos
        : [];
    await setUserTeams(usuarioId, rawIds);
    const updatedUser = await findUserById(usuarioId);
    return { usuario: updatedUser };
  });

  app.get('/equipos', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Obtener todos los equipos',
      description: 'Devuelve la lista de equipos registrados junto con los IDs de usuarios que pertenecen a cada uno.',
      security: adminSecurity,
    },
  }, async () => {
    const equipos = await listTeams();
    return { equipos };
  });

  app.post('/equipos', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Crear un equipo',
      description: 'Crea un nuevo equipo y opcionalmente asigna sus miembros iniciales.',
      security: adminSecurity,
      body: {
        type: 'object',
        required: ['nombre'],
        properties: {
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          usuarioIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const { nombre, usuarioIds } = request.body || {};
    if (typeof nombre !== 'string' || !nombre.trim()) {
      return reply.code(400).send({ error: 'El nombre del equipo es obligatorio.' });
    }
    const result = await createTeam({ nombre, usuarioIds });
    if (result.invalid) {
      return reply.code(400).send({ error: 'El nombre del equipo no es válido (máximo 120 caracteres).' });
    }
    if (result.duplicate) {
      return reply.code(409).send({ error: 'Ya existe un equipo con ese nombre.' });
    }
    return reply.code(201).send({ equipo: result.team });
  });

  app.patch('/equipos/:equipoId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Actualizar un equipo y/o sus usuarios',
      description: 'Permite renombrar un equipo y/o actualizar la lista de usuarios que pertenecen a él.',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['equipoId'],
        properties: { equipoId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        minProperties: 1,
        additionalProperties: false,
        properties: {
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          usuarioIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const { equipoId } = request.params;
    const { nombre, usuarioIds } = request.body || {};
    if (nombre !== undefined && (typeof nombre !== 'string' || !nombre.trim())) {
      return reply.code(400).send({ error: 'El nombre del equipo no puede estar vacío.' });
    }
    const result = await updateTeam(equipoId, { nombre, usuarioIds });
    if (result.notFound) {
      return reply.code(404).send({ error: 'Equipo no encontrado.' });
    }
    if (result.invalid) {
      return reply.code(400).send({ error: 'El nombre del equipo no es válido (máximo 120 caracteres).' });
    }
    if (result.duplicate) {
      return reply.code(409).send({ error: 'Ya existe otro equipo con ese nombre.' });
    }
    return { equipo: result.team };
  });

  app.delete('/equipos/:equipoId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Equipos'],
      summary: 'Eliminar un equipo',
      description: 'Elimina el equipo y desvincula a todos los usuarios asignados a él.',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['equipoId'],
        properties: { equipoId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { equipoId } = request.params;
    const result = await deleteTeam(equipoId);
    if (result.notFound) {
      return reply.code(404).send({ error: 'Equipo no encontrado.' });
    }
    return { eliminado: true, id: result.id };
  });

  app.get('/oficinas', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Obtener todas las oficinas con sus calendarios y festivos',
      security: adminSecurity,
    },
  }, async () => {
    const oficinas = await listOffices();
    return { oficinas };
  });

  app.post('/oficinas', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Crear una oficina',
      security: adminSecurity,
      body: {
        type: 'object',
        required: ['nombre'],
        properties: {
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          usuarioIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const { nombre, usuarioIds } = request.body || {};
    if (typeof nombre !== 'string' || !nombre.trim()) {
      return reply.code(400).send({ error: 'El nombre de la oficina es obligatorio.' });
    }
    const result = await createOffice({ nombre, usuarioIds });
    if (result.invalid) {
      return reply.code(400).send({ error: 'El nombre de la oficina no es válido (máximo 120 caracteres).' });
    }
    if (result.duplicate) {
      return reply.code(409).send({ error: 'Ya existe una oficina con ese nombre.' });
    }
    return reply.code(201).send({ oficina: result.office });
  });

  app.patch('/oficinas/:oficinaId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Actualizar una oficina y/o sus usuarios asignados',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        minProperties: 1,
        additionalProperties: false,
        properties: {
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          usuarioIds: { type: 'array', items: { type: 'integer', minimum: 1 } },
        },
      },
    },
  }, async (request, reply) => {
    const { oficinaId } = request.params;
    const { nombre, usuarioIds } = request.body || {};
    if (nombre !== undefined && (typeof nombre !== 'string' || !nombre.trim())) {
      return reply.code(400).send({ error: 'El nombre de la oficina no puede estar vacío.' });
    }
    const result = await updateOffice(oficinaId, { nombre, usuarioIds });
    if (result.notFound) {
      return reply.code(404).send({ error: 'Oficina no encontrada.' });
    }
    if (result.invalid) {
      return reply.code(400).send({ error: 'El nombre de la oficina no es válido (máximo 120 caracteres).' });
    }
    if (result.duplicate) {
      return reply.code(409).send({ error: 'Ya existe otra oficina con ese nombre.' });
    }
    return { oficina: result.office };
  });

  app.delete('/oficinas/:oficinaId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Eliminar una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { oficinaId } = request.params;
    const result = await deleteOffice(oficinaId);
    if (result.notFound) {
      return reply.code(404).send({ error: 'Oficina no encontrada.' });
    }
    return { eliminado: true, id: result.id };
  });

  app.post('/oficinas/:oficinaId/calendarios', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Crear o asegurar un calendario anual para una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        required: ['anio'],
        properties: {
          anio: { type: 'integer', minimum: 1900, maximum: 2200 },
        },
      },
    },
  }, async (request, reply) => {
    const { oficinaId } = request.params;
    const { anio } = request.body || {};
    const result = await createOfficeCalendar(oficinaId, anio);
    if (result.invalidYear) {
      return reply.code(400).send({ error: 'El año del calendario debe estar entre 1900 y 2200.' });
    }
    if (result.notFound) {
      return reply.code(404).send({ error: 'Oficina no encontrada.' });
    }
    return reply.code(201).send({ oficina: result.office });
  });

  app.delete('/oficinas/:oficinaId/calendarios/:calendarioId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Eliminar un calendario anual y sus días festivos',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId', 'calendarioId'],
        properties: {
          oficinaId: { type: 'integer', minimum: 1 },
          calendarioId: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { oficinaId, calendarioId } = request.params;
    const result = await deleteOfficeCalendar(oficinaId, calendarioId);
    if (result.notFound) {
      return reply.code(404).send({ error: 'Calendario anual no encontrado para esta oficina.' });
    }
    return { eliminado: true, oficina: result.office };
  });

  app.post('/oficinas/:oficinaId/festivos', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Añadir un día festivo a una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId'],
        properties: { oficinaId: { type: 'integer', minimum: 1 } },
      },
      body: {
        type: 'object',
        required: ['fecha', 'nombre'],
        properties: {
          fecha: { type: 'string', format: 'date' },
          nombre: { type: 'string', minLength: 1, maxLength: 120 },
          anio: { type: 'integer', minimum: 1900, maximum: 2200 },
        },
      },
    },
  }, async (request, reply) => {
    const { oficinaId } = request.params;
    const { fecha, nombre, anio } = request.body || {};
    const result = await addOfficeHoliday(oficinaId, { fecha, nombre, anio });
    if (result.invalid) {
      return reply.code(400).send({ error: 'Indica una fecha válida (YYYY-MM-DD) y un nombre de festivo (máximo 120 caracteres).' });
    }
    if (result.invalidYearMismatch) {
      return reply.code(400).send({ error: 'La fecha seleccionada no corresponde al año del calendario indicado.' });
    }
    if (result.notFound) {
      return reply.code(404).send({ error: 'Oficina no encontrada.' });
    }
    if (result.duplicate) {
      return reply.code(409).send({ error: 'Ya existe un día festivo registrado en esa fecha para esta oficina.' });
    }
    return reply.code(201).send({ oficina: result.office });
  });

  app.delete('/oficinas/:oficinaId/festivos/:festivoId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Oficinas'],
      summary: 'Eliminar un día festivo de una oficina',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['oficinaId', 'festivoId'],
        properties: {
          oficinaId: { type: 'integer', minimum: 1 },
          festivoId: { type: 'integer', minimum: 1 },
        },
      },
    },
  }, async (request, reply) => {
    const { oficinaId, festivoId } = request.params;
    const result = await deleteOfficeHoliday(oficinaId, festivoId);
    if (result.notFound) {
      return reply.code(404).send({ error: 'Día festivo no encontrado para esta oficina.' });
    }
    return { eliminado: true, id: result.id, oficina: result.office };
  });

  app.post('/sesiones/invitaciones', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Invitar usuarios sin sesión activa',
      security: adminSecurity,
    },
  }, async () => {
    const users = await listUsersWithoutActiveSession();
    const result = await inviteUsersWithoutActiveSession(users);
    return {
      total: users.length,
      enviadas: result.sent,
      fallidas: result.failed,
      omitidas: result.skipped || 0,
    };
  });

  app.post('/vacaciones/recordatorio', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Enviar recordatorio de registro de vacaciones a usuarios autenticados',
      description: 'Envía un correo electrónico a todos los usuarios con sesión autorizada activa recordándoles entrar en la aplicación y registrar sus vacaciones previstas para los próximos meses.',
      security: adminSecurity,
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

  app.post('/usuarios/:usuarioId/invitacion', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Enviar invitación a un usuario',
      security: adminSecurity,
      params: {
        type: 'object',
        required: ['usuarioId'],
        properties: { usuarioId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const user = await findUserById(request.params.usuarioId);
    if (!user) return reply.code(404).send({ error: 'Usuario no encontrado.' });
    try {
      const result = await issueInvitation(user);
      if (result?.alreadyInProcess) {
        return reply.code(409).send({
          error: 'El usuario ya tiene una invitación en proceso.',
          yaEnProceso: true,
          enviada: false,
        });
      }
      return { enviada: true };
    } catch (error) {
      if (error?.statusCode === 429) {
        if (error.retryAfterSeconds) {
          reply.header('Retry-After', String(error.retryAfterSeconds));
        }
        return reply.code(429).send({
          error: error.message,
          ...(error.retryAfterSeconds ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
        });
      }
      request.log.error({ err: error }, 'No se pudo enviar la invitación');
      return reply.code(503).send({ error: 'No se pudo enviar la invitación. Revisa la configuración de correo.' });
    }
  });
}
