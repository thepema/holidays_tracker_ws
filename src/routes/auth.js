import { clearSessionCookie, requireAdmin, requireAdminOrSession, setSessionCookie } from '../lib/security.js';
import { activateSession, recoverSession, requestNewSession, revokeSession } from '../services/sessionService.js';
import { findUserById } from '../services/userService.js';

const sessionSecurity = [{ SessionCookie: [] }, { AdminBearerAuth: [] }];
const adminSecurity = [{ AdminBearerAuth: [] }];

export default async function authRoutes(app) {
  app.post('/sesiones/activar', {
    schema: {
      tags: ['Sesiones'],
      summary: 'Activar sesión con código de invitación',
      body: {
        type: 'object',
        required: ['codigo'],
        properties: { codigo: { type: 'string', minLength: 20, maxLength: 200 } },
      },
    },
  }, async (request, reply) => {
    const { codigo } = request.body || {};
    if (typeof codigo !== 'string' || codigo.length < 20 || codigo.length > 200) {
      return reply.code(400).send({ error: 'Se requiere un código de acceso válido.' });
    }
    try {
      const result = await activateSession(codigo);
      if (!result) return reply.code(401).send({ error: 'El código no es válido o ya fue utilizado.' });
      setSessionCookie(reply, result.token);
      return { usuario: result.user };
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo activar la sesión');
      return reply.code(503).send({ error: 'No se pudo activar la sesión.' });
    }
  });

  app.post('/sesiones/recuperar', {
    schema: {
      tags: ['Sesiones'],
      summary: 'Recuperar sesión',
      body: {
        type: 'object',
        required: ['email', 'codigoRecuperacion'],
        properties: {
          email: { type: 'string', format: 'email' },
          codigoRecuperacion: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const { email, codigoRecuperacion } = request.body || {};
    if (typeof email !== 'string' || typeof codigoRecuperacion !== 'string' || !email.trim() || !codigoRecuperacion) {
      return reply.code(400).send({ error: 'Se requieren email y codigoRecuperacion.' });
    }
    try {
      const result = await recoverSession(email, codigoRecuperacion);
      if (!result) return reply.code(401).send({ error: 'Los datos de recuperación no son válidos.' });
      setSessionCookie(reply, result.token);
      return { usuario: result.user };
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo recuperar la sesión');
      return reply.code(503).send({ error: 'No se pudo recuperar la sesión.' });
    }
  });

  app.post('/sesiones/solicitar', {
    preHandler: requireAdminOrSession,
    schema: {
      tags: ['Sesiones'],
      summary: 'Solicitar una nueva sesión al administrador',
      description: 'El usuario autenticado solicita su propia sesión. El administrador debe indicar usuarioId.',
      security: sessionSecurity,
      body: {
        type: 'object',
        properties: { usuarioId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    try {
      let user = request.user;
      if (request.isAdmin) {
        const { usuarioId } = request.body || {};
        if (!Number.isInteger(usuarioId) || usuarioId < 1) {
          return reply.code(400).send({ error: 'El administrador debe indicar un usuarioId válido.' });
        }
        user = await findUserById(usuarioId);
        if (!user) return reply.code(404).send({ error: 'Usuario no encontrado.' });
      }
      await requestNewSession(user);
      if (!request.isAdmin) clearSessionCookie(reply);
      return reply.code(202).send({ mensaje: 'Solicitud enviada al administrador.' });
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo enviar la solicitud de sesión');
      return reply.code(503).send({ error: 'No se pudo enviar la solicitud al administrador.' });
    }
  });

  app.post('/sesiones/cerrar', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Sesiones'],
      summary: 'Revocar la sesión de un usuario',
      description: 'Solo el administrador puede revocar sesiones. Los usuarios pueden recuperar el acceso mediante su código de recuperación.',
      security: adminSecurity,
      body: {
        type: 'object',
        required: ['usuarioId'],
        properties: { usuarioId: { type: 'integer', minimum: 1 } },
      },
    },
  }, async (request, reply) => {
    const { usuarioId } = request.body || {};
    if (!Number.isInteger(usuarioId) || usuarioId < 1) {
      return reply.code(400).send({ error: 'Se requiere un usuarioId válido.' });
    }
    const user = await findUserById(usuarioId);
    if (!user) return reply.code(404).send({ error: 'Usuario no encontrado.' });
    await revokeSession(usuarioId);
    return { cerrado: true, usuarioId };
  });
}
