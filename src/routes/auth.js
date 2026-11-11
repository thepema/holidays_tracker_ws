import { clearSessionCookie, requireAdmin, requireSession, setSessionCookie } from '../lib/security.js';
import {
  activateSession,
  markSessionAsRequested,
  recoverSession,
  requestNewSession,
  revokeSession,
} from '../services/sessionService.js';
import {
  findUserByEmail,
  findUserById,
  findUserByNameAndEmail,
} from '../services/userService.js';

const sessionSecurity = [{ SessionCookie: [] }, { AdminBearerAuth: [] }];
const adminSecurity = [{ AdminBearerAuth: [] }];

export default async function authRoutes(app) {
  app.get('/sesiones/me', {
    preHandler: requireSession,
    schema: {
      tags: ['Sesiones'],
      summary: 'Obtener sesión actual del usuario',
      security: [{ SessionCookie: [] }],
    },
  }, async (request) => {
    return {
      autenticado: true,
      usuario: request.user,
    };
  });

  const activateSessionHandler = async (request, reply) => {
    const codigo = request.params?.codigo || request.body?.codigo || request.body?.request_token || request.body?.requestToken || request.query?.codigo || request.query?.request_token;
    if (typeof codigo !== 'string' || codigo.length < 20 || codigo.length > 200) {
      return reply.code(400).send({ error: 'Se requiere un código de acceso válido.' });
    }
    try {
      const result = await activateSession(codigo);
      if (!result) return reply.code(401).send({ error: 'El código no es válido o ya fue utilizado.' });
      setSessionCookie(reply, result.token);
      return {
        usuario: result.user,
        token: result.token,
        codigoRecuperacion: result.recoveryCode,
      };
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo activar la sesión');
      return reply.code(503).send({ error: 'No se pudo activar la sesión.' });
    }
  };

  const activateSchema = {
    tags: ['Sesiones'],
    summary: 'Activar sesión con código de invitación / request_token',
    description: 'Valida el request_token recibido en la URL de invitación, genera la sesión activa en forma de cookie ht_session y elimina el request_token.',
    body: {
      type: 'object',
      properties: {
        codigo: { type: 'string', minLength: 20, maxLength: 200 },
        request_token: { type: 'string', minLength: 20, maxLength: 200 },
        requestToken: { type: 'string', minLength: 20, maxLength: 200 },
      },
    },
    response: {
      200: {
        type: 'object',
        properties: {
          usuario: {
            type: 'object',
            properties: {
              id: { type: 'integer' },
              nombre: { type: 'string' },
              apellidos: { type: 'string' },
              email: { type: 'string' },
              cargo: { type: 'string' },
              tipo_vacaciones: { type: 'string' },
            },
          },
          token: { type: 'string' },
          codigoRecuperacion: { type: 'string' },
        },
        required: ['usuario', 'token', 'codigoRecuperacion'],
      },
    },
  };

  app.post('/sesiones/activar', { schema: activateSchema }, activateSessionHandler);
  app.post('/sesiones/activar/:codigo', { schema: activateSchema }, activateSessionHandler);

  app.post('/sesiones/recuperar', {
    schema: {
      tags: ['Sesiones'],
      summary: 'Recuperar sesión mediante token de recuperación',
      body: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          codigoRecuperacion: { type: 'string' },
          codigo: { type: 'string' },
          token: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            usuario: {
              type: 'object',
              properties: {
                id: { type: 'integer' },
                nombre: { type: 'string' },
                apellidos: { type: 'string' },
                email: { type: 'string' },
                cargo: { type: 'string' },
                tipo_vacaciones: { type: 'string' },
              },
            },
            token: { type: 'string' },
            codigoRecuperacion: { type: 'string' },
          },
          required: ['usuario', 'token', 'codigoRecuperacion'],
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body || {};
    const codigoRecuperacion = String(
      body.codigoRecuperacion || body.token || body.codigo || ''
    ).trim();
    const email = typeof body.email === 'string' ? body.email.trim() : '';

    if (!codigoRecuperacion) {
      return reply.code(400).send({ error: 'Se requiere un token de recuperación válido.' });
    }
    try {
      const result = await recoverSession(codigoRecuperacion, email);
      if (!result) {
        return reply.code(401).send({ error: 'El token de recuperación no es válido o la sesión fue revocada.' });
      }
      setSessionCookie(reply, result.token);
      return {
        usuario: result.user,
        token: result.token,
        codigoRecuperacion: result.recoveryCode,
      };
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo recuperar la sesión');
      return reply.code(503).send({ error: 'No se pudo recuperar la sesión.' });
    }
  });

  app.post('/sesiones/solicitar', {
    schema: {
      tags: ['Sesiones'],
      summary: 'Solicitar una nueva sesión al administrador',
      description: 'Cruza nombre y correo con la base de datos y registra la sesión como solicitado, o permite al administrador/usuario solicitarla.',
      security: sessionSecurity,
      body: {
        type: 'object',
        properties: {
          usuarioId: { type: 'integer', minimum: 1 },
          nombre: { type: 'string' },
          email: { type: 'string' },
          identificador: { type: 'string' },
          codigo: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body || {};
      const nombre = typeof body.nombre === 'string' ? body.nombre.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim() : '';

      if (nombre && email) {
        const matchedUser = await findUserByNameAndEmail(nombre, email);
        if (!matchedUser) {
          return reply.code(404).send({
            error: 'No se ha encontrado ningún usuario con ese nombre y correo electrónico.',
          });
        }
        await markSessionAsRequested(matchedUser);
        return reply.code(202).send({
          solicitado: true,
          mensaje: 'Solicitud de sesión registrada correctamente.',
        });
      }

      if (Number.isInteger(body.usuarioId) && body.usuarioId >= 1) {
        const userById = await findUserById(body.usuarioId);
        if (!userById) return reply.code(404).send({ error: 'Usuario no encontrado.' });
        await markSessionAsRequested(userById);
        return reply.code(202).send({
          solicitado: true,
          mensaje: 'Solicitud enviada al administrador.',
        });
      }

      if (email) {
        const userByEmail = await findUserByEmail(email);
        if (!userByEmail) {
          return reply.code(404).send({ error: 'No se ha encontrado ningún usuario con ese correo.' });
        }
        await markSessionAsRequested(userByEmail);
        return reply.code(202).send({
          solicitado: true,
          mensaje: 'Solicitud enviada al administrador.',
        });
      }

      if (request.user) {
        await markSessionAsRequested(request.user);
        clearSessionCookie(reply);
        return reply.code(202).send({
          solicitado: true,
          mensaje: 'Solicitud enviada al administrador.',
        });
      }

      return reply.code(400).send({
        error: 'Debes indicar tu nombre y correo electrónico para solicitar la sesión.',
      });
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo enviar la solicitud de sesión');
      return reply.code(503).send({ error: 'No se pudo registrar la solicitud de sesión.' });
    }
  });

  app.post('/sesiones/cerrar', {
    preHandler: requireAdmin,
    schema: {
      tags: ['Sesiones'],
      summary: 'Revocar la sesión de un usuario',
      description: 'Solo el administrador puede revocar sesiones. Invalida la sesión y el código de recuperación; para volver a acceder se debe solicitar o enviar una nueva invitación.',
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
