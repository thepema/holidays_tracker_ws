import { appError } from '../../shared/errors.js';
import { requireAdmin } from '../../shared/security.js';
import {
  createUser,
  findUserById,
  listNonAdminUsers,
  listUsersWithPendingInvitation,
  updateUser,
} from './users.service.js';
import { setUserTeams } from '../teams/teams.service.js';
import { issueInvitation } from '../auth/session.service.js';

const adminSecurity = [{ AdminBearerAuth: [] }];

export default async function usersRoutes(app) {
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
      throw appError('USER_MISSING_REQUIRED_FIELDS', { fields: required });
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email.trim())) {
      throw appError('USER_INVALID_EMAIL');
    }
    const user = await createUser(input);
    return reply.code(201).send({ usuario: user });
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
  }, async (request) => {
    const { usuarioId } = request.params;
    const existing = await findUserById(usuarioId);
    if (!existing) {
      throw appError('USER_NOT_FOUND');
    }

    const updates = request.body || {};
    const stringKeys = ['codigo', 'nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'];
    for (const key of stringKeys) {
      if (updates[key] !== undefined && (typeof updates[key] !== 'string' || !updates[key].trim())) {
        throw appError('USER_EMPTY_FIELD', { field: key });
      }
    }

    if (updates.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(updates.email.trim())) {
      throw appError('USER_INVALID_EMAIL');
    }

    const updatedUser = await updateUser(usuarioId, updates);
    return { usuario: updatedUser };
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
  }, async (request) => {
    const { usuarioId } = request.params;
    const existing = await findUserById(usuarioId);
    if (!existing) {
      throw appError('USER_NOT_FOUND');
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
  }, async (request) => {
    const user = await findUserById(request.params.usuarioId);
    if (!user) throw appError('USER_NOT_FOUND');
    await issueInvitation(user, { throwOnInProcess: true });
    return { enviada: true };
  });
}
