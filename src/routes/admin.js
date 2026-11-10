import { requireAdmin, createAdminToken, verifyAdminPassword, ADMIN_TOKEN_TTL_SECONDS } from '../lib/security.js';
import {
  createUser,
  findUserById,
  listNonAdminUsers,
  listUsersWithPendingInvitation,
  listUsersWithoutActiveSession,
  updateUser,
} from '../services/userService.js';
import { inviteUsersWithoutActiveSession, issueInvitation } from '../services/sessionService.js';

const adminSecurity = [{ AdminBearerAuth: [] }];

export default async function adminRoutes(app) {
  app.post('/admin/login', {
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
      description: 'Devuelve todos los usuarios cuyo cargo no sea de administrador. Requiere un token Bearer obtenido en /api/admin/login.',
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
        required: ['nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'],
        properties: {
          nombre: { type: 'string' },
          apellidos: { type: 'string' },
          cargo: { type: 'string' },
          email: { type: 'string', format: 'email' },
          tipo_vacaciones: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const input = request.body || {};
    const required = ['nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'];
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
      if (error.code === '23505') return reply.code(409).send({ error: 'Ya existe un usuario con ese email.' });
      if (error.code === '23514') return reply.code(400).send({ error: 'Los datos del usuario no son válidos.' });
      throw error;
    }
  });

  app.patch('/usuarios/:usuarioId', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Administración'],
      summary: 'Editar usuario',
      description: 'Permite actualizar parcialmente los datos de un usuario. Requiere token Bearer de administrador.',
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
          nombre: { type: 'string' },
          apellidos: { type: 'string' },
          cargo: { type: 'string' },
          email: { type: 'string', format: 'email' },
          tipo_vacaciones: { type: 'string' },
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
    const stringKeys = ['nombre', 'apellidos', 'cargo', 'email', 'tipo_vacaciones'];
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
      if (error.code === '23505') return reply.code(409).send({ error: 'Ya existe un usuario con ese email.' });
      if (error.code === '23514') return reply.code(400).send({ error: 'Los datos del usuario no son válidos.' });
      throw error;
    }
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
    return { total: users.length, enviadas: result.sent, fallidas: result.failed };
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
      await issueInvitation(user);
      return { enviada: true };
    } catch {
      return reply.code(503).send({ error: 'No se pudo enviar la invitación. Revisa la configuración de correo.' });
    }
  });
}
