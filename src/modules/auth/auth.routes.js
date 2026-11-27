import { AppError, appError } from '../../shared/errors.js';
import { createRateLimitPreHandler } from '../../shared/rateLimiter.js';
import {
  ADMIN_TOKEN_TTL_SECONDS,
  clearSessionCookie,
  createAdminToken,
  isValidAdminToken,
  requireAdmin,
  requireSession,
  setSessionCookie,
  verifyAdminPassword,
} from '../../shared/security.js';
import {
  activateSession,
  confirmSessionResetWithCode,
  getSessionApiToken,
  initiateSessionResetVerification,
  inviteUsersWithoutActiveSession,
  markSessionAsRequested,
  recoverSession,
  revokeSession,
} from './session.service.js';
import {
  findUserByEmail,
  findUserById,
  getAdminSessionsSummary,
  listUsersWithoutActiveSession,
} from '../users/users.service.js';

const sessionSecurity = [{ SessionCookie: [] }, { AdminBearerAuth: [] }];
const adminSecurity = [{ AdminBearerAuth: [] }];

const adminLoginRateLimit = createRateLimitPreHandler({
  bucket: 'route:admin:login',
  maxRequests: 8,
  windowMs: 15 * 60 * 1000,
  errorMessage: 'Demasiados intentos de inicio de sesión de administrador.',
});

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

function isAdminBearerRequest(request) {
  const bearerToken = request.headers.authorization?.replace(/^Bearer\s+/i, '') || '';
  return isValidAdminToken(bearerToken);
}

function skipRateLimitForAdmin(rateLimitHandler) {
  return async (request, reply) => {
    if (isAdminBearerRequest(request)) return;
    return rateLimitHandler(request, reply);
  };
}

export default async function authRoutes(app) {
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
  }, async (request) => {
    if (!process.env.ADMIN_PASSWORD || !process.env.ADMIN_TOKEN_SECRET) {
      throw appError('ADMIN_AUTH_NOT_CONFIGURED');
    }

    const { password } = request.body || {};
    if (!verifyAdminPassword(password)) {
      throw appError('ADMIN_INVALID_CREDENTIALS');
    }

    return {
      token: createAdminToken(),
      tokenType: 'Bearer',
      expiresIn: ADMIN_TOKEN_TTL_SECONDS,
    };
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

  app.get('/sesiones/api-token', {
    preHandler: requireSession,
    schema: {
      tags: ['Sesiones'],
      summary: 'Obtener API token personal (token_hash de sesión) para agentes de IA (MCP)',
      security: [{ SessionCookie: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            apiToken: { type: 'string' },
            headerName: { type: 'string' },
          },
          required: ['apiToken', 'headerName'],
        },
      },
    },
  }, async (request) => {
    const apiToken = await getSessionApiToken(request.user.id);
    if (!apiToken) {
      throw appError('API_TOKEN_FORBIDDEN');
    }
    return {
      apiToken,
      headerName: 'x-api-key',
    };
  });

  const activateSessionHandler = async (request, reply) => {
    const codigo = request.params?.codigo || request.body?.codigo || request.body?.request_token || request.body?.requestToken || request.query?.codigo || request.query?.request_token;
    if (typeof codigo !== 'string' || codigo.length < 20 || codigo.length > 200) {
      throw appError('INVALID_ACCESS_CODE_FORMAT');
    }
    try {
      const result = await activateSession(codigo);
      if (!result) throw appError('INVALID_OR_USED_ACCESS_CODE');
      setSessionCookie(reply, result.token);
      return {
        usuario: result.user,
        token: result.token,
        codigoRecuperacion: result.recoveryCode,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw appError('SESSION_ACTIVATION_FAILED', { cause: error });
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
      throw appError('INVALID_RECOVERY_TOKEN_FORMAT');
    }
    try {
      const result = await recoverSession(codigoRecuperacion, email);
      if (!result) {
        throw appError('INVALID_OR_REVOKED_RECOVERY_TOKEN');
      }
      setSessionCookie(reply, result.token);
      return {
        usuario: result.user,
        token: result.token,
        codigoRecuperacion: result.recoveryCode,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw appError('SESSION_RECOVERY_FAILED', { cause: error });
    }
  });

  const handleConfirmResetCode = async (reply, matchedUser, verificationCode) => {
    await confirmSessionResetWithCode(matchedUser, verificationCode);
    return reply.code(202).send({
      solicitado: true,
      mensaje: 'Código verificado. Solicitud de sesión registrada correctamente.',
    });
  };

  app.post('/sesiones/solicitar', {
    preHandler: [
      skipRateLimitForAdmin(requestSessionMinuteLimit),
      skipRateLimitForAdmin(requestSessionHourLimit),
    ],
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
          throw appError('USER_EMAIL_NOT_FOUND');
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
          throw appError('ADMIN_USER_ID_UNAUTHORIZED');
        }
        const userById = await findUserById(body.usuarioId);
        if (!userById) throw appError('USER_NOT_FOUND');
        await markSessionAsRequested(userById, { initiatedByAdmin: true });
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

      throw appError('RESET_EMAIL_REQUIRED');
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw appError('SESSION_REQUEST_FAILED', { cause: error });
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
        throw appError('CONFIRM_EMAIL_REQUIRED');
      }

      const matchedUser = await findUserByEmail(email);
      if (!matchedUser) {
        throw appError('USER_EMAIL_NOT_FOUND');
      }

      return handleConfirmResetCode(reply, matchedUser, verificationCode);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw appError('SESSION_CONFIRM_FAILED', { cause: error });
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
  }, async (request) => {
    const { usuarioId } = request.body || {};
    if (!Number.isInteger(usuarioId) || usuarioId < 1) {
      throw appError('VALID_USER_ID_REQUIRED');
    }
    const user = await findUserById(usuarioId);
    if (!user) throw appError('USER_NOT_FOUND');
    await revokeSession(usuarioId);
    return { cerrado: true, usuarioId };
  });
}
