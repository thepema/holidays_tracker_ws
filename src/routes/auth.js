import { createRateLimitPreHandler } from '../lib/rateLimiter.js';
import {
  clearSessionCookie,
  isValidAdminToken,
  requireAdmin,
  requireSession,
  setSessionCookie,
} from '../lib/security.js';
import {
  activateSession,
  confirmSessionResetWithCode,
  initiateSessionResetVerification,
  markSessionAsRequested,
  recoverSession,
  revokeSession,
} from '../services/sessionService.js';
import {
  findUserByEmail,
  findUserById,
} from '../services/userService.js';

const sessionSecurity = [{ SessionCookie: [] }, { AdminBearerAuth: [] }];
const adminSecurity = [{ AdminBearerAuth: [] }];

const activateRateLimit = createRateLimitPreHandler({
  bucket: 'route:sesiones:activar',
  maxRequests: 10,
  windowMs: 10 * 60 * 1000,
  errorMessage: 'Demasiados intentos de activación de sesión.',
});

const recoverRateLimit = createRateLimitPreHandler({
  bucket: 'route:sesiones:recuperar',
  maxRequests: 10,
  windowMs: 10 * 60 * 1000,
  errorMessage: 'Demasiados intentos de recuperación de sesión.',
});

const requestSessionMinuteLimit = createRateLimitPreHandler({
  bucket: 'route:sesiones:solicitar:minuto',
  maxRequests: 5,
  windowMs: 60 * 1000,
  errorMessage: 'Demasiadas solicitudes de código en poco tiempo.',
});

const requestSessionHourLimit = createRateLimitPreHandler({
  bucket: 'route:sesiones:solicitar:hora',
  maxRequests: 20,
  windowMs: 60 * 60 * 1000,
  errorMessage: 'Has superado el límite horario de solicitudes desde esta IP.',
});

const confirmResetRateLimit = createRateLimitPreHandler({
  bucket: 'route:sesiones:solicitar:confirmar',
  maxRequests: 10,
  windowMs: 10 * 60 * 1000,
  errorMessage: 'Demasiados intentos de confirmación de código.',
});

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
              codigo: { type: 'string' },
              nombre: { type: 'string' },
              apellidos: { type: 'string' },
              email: { type: 'string' },
              cargo: { type: 'string' },
              tipo_vacaciones: { type: 'string' },
              oficinaId: { type: ['integer', 'null'] },
              oficinaNombre: { type: ['string', 'null'] },
            },
          },
          token: { type: 'string' },
          codigoRecuperacion: { type: 'string' },
        },
        required: ['usuario', 'token', 'codigoRecuperacion'],
      },
    },
  };

  app.post('/sesiones/activar', { preHandler: activateRateLimit, schema: activateSchema }, activateSessionHandler);
  app.post('/sesiones/activar/:codigo', { preHandler: activateRateLimit, schema: activateSchema }, activateSessionHandler);

  app.post('/sesiones/recuperar', {
    preHandler: recoverRateLimit,
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
                codigo: { type: 'string' },
                nombre: { type: 'string' },
                apellidos: { type: 'string' },
                email: { type: 'string' },
                cargo: { type: 'string' },
                tipo_vacaciones: { type: 'string' },
                oficinaId: { type: ['integer', 'null'] },
                oficinaNombre: { type: ['string', 'null'] },
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

  const handleConfirmResetCode = async (reply, matchedUser, verificationCode) => {
    const result = await confirmSessionResetWithCode(matchedUser, verificationCode);
    if (result.invalidFormat) {
      return reply.code(400).send({
        error: 'El código de verificación debe tener 6 dígitos numéricos.',
      });
    }
    if (result.expiredOrMissing) {
      return reply.code(400).send({
        error: 'No hay ningún código pendiente o el código ha caducado. Solicita uno nuevo.',
      });
    }
    if (result.tooManyAttempts) {
      return reply.code(429).send({
        error: 'Has superado el máximo de intentos. Solicita un nuevo código de verificación.',
      });
    }
    if (result.invalidCode) {
      return reply.code(401).send({
        error: `El código numérico no es correcto. Te quedan ${result.remainingAttempts} intentos.`,
      });
    }
    return reply.code(202).send({
      solicitado: true,
      mensaje: 'Código verificado. Solicitud de sesión registrada correctamente.',
    });
  };

  app.post('/sesiones/solicitar', {
    preHandler: [requestSessionMinuteLimit, requestSessionHourLimit],
    schema: {
      tags: ['Sesiones'],
      summary: 'Solicitar una nueva sesión mediante verificación numérica por correo',
      description: 'Busca al usuario por correo electrónico y envía un código numérico de 6 dígitos al correo del usuario. Si se adjunta codigoVerificacion, valida el código y registra el reseteo/solicitud de sesión.',
      security: sessionSecurity,
      body: {
        type: 'object',
        properties: {
          usuarioId: { type: 'integer', minimum: 1 },
          email: { type: 'string' },
          identificador: { type: 'string' },
          codigo: { type: 'string' },
          codigoVerificacion: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body || {};
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const verificationCode =
        typeof body.codigoVerificacion === 'string'
          ? body.codigoVerificacion.trim()
          : typeof body.codigo === 'string'
            ? body.codigo.trim()
            : '';

      if (email) {
        const matchedUser = await findUserByEmail(email);
        if (!matchedUser) {
          return reply.code(404).send({
            error: 'No se ha encontrado ningún usuario con ese correo electrónico.',
          });
        }
        if (verificationCode) {
          return handleConfirmResetCode(reply, matchedUser, verificationCode);
        }
        const verificationResult = await initiateSessionResetVerification(matchedUser);
        return reply.code(200).send({
          requiereVerificacion: true,
          solicitado: false,
          cooldownSeconds: verificationResult.cooldownSeconds,
          mensaje:
            'Hemos enviado un código numérico de 6 dígitos a tu correo electrónico. Introdúcelo para confirmar el reseteo y solicitud de sesión.',
        });
      }

      if (Number.isInteger(body.usuarioId) && body.usuarioId >= 1) {
        const bearerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
        if (!isValidAdminToken(bearerToken)) {
          return reply.code(401).send({
            error: 'No autorizado para solicitar una sesión por usuarioId.',
          });
        }
        const userById = await findUserById(body.usuarioId);
        if (!userById) return reply.code(404).send({ error: 'Usuario no encontrado.' });
        await markSessionAsRequested(userById);
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
        error: 'Debes indicar tu correo electrónico para recibir el código de verificación.',
      });
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
      request.log.error({ err: error }, 'No se pudo enviar la solicitud de sesión');
      return reply.code(503).send({ error: 'No se pudo procesar la verificación de solicitud de sesión.' });
    }
  });

  app.post('/sesiones/solicitar/confirmar', {
    preHandler: confirmResetRateLimit,
    schema: {
      tags: ['Sesiones'],
      summary: 'Confirmar código numérico de verificación y registrar solicitud de sesión',
      description: 'Valida el código numérico de 6 dígitos enviado por correo al usuario antes de resetear y marcar la sesión como solicitado.',
      body: {
        type: 'object',
        required: ['email'],
        properties: {
          email: { type: 'string', minLength: 1 },
          codigoVerificacion: { type: 'string' },
          codigo: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    try {
      const body = request.body || {};
      const email = typeof body.email === 'string' ? body.email.trim() : '';
      const verificationCode =
        typeof body.codigoVerificacion === 'string'
          ? body.codigoVerificacion.trim()
          : typeof body.codigo === 'string'
            ? body.codigo.trim()
            : '';

      if (!email) {
        return reply.code(400).send({
          error: 'Debes indicar tu correo electrónico.',
        });
      }

      const matchedUser = await findUserByEmail(email);
      if (!matchedUser) {
        return reply.code(404).send({
          error: 'No se ha encontrado ningún usuario con ese correo electrónico.',
        });
      }

      return handleConfirmResetCode(reply, matchedUser, verificationCode);
    } catch (error) {
      request.log.error({ err: error }, 'No se pudo confirmar la solicitud de sesión');
      return reply.code(503).send({ error: 'No se pudo confirmar la solicitud de sesión.' });
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
