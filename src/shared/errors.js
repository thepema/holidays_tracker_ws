/**
 * @typedef {Object} ErrorDefinition
 * @property {number} status
 * @property {string | ((params?: any) => string)} message
 * @property {(params?: any) => Record<string, any>} [body]
 * @property {(params?: any) => Record<string, string>} [headers]
 */

/** @satisfies {Record<string, ErrorDefinition>} */
export const ERROR_CATALOG = {
  // Administración y Autenticación
  ADMIN_AUTH_NOT_CONFIGURED: {
    status: 503,
    message: 'La autenticación de administración no está configurada.',
  },
  ADMIN_INVALID_CREDENTIALS: {
    status: 401,
    message: 'Credenciales de administrador no válidas.',
  },
  UNAUTHORIZED: {
    status: 401,
    message: 'No autorizado.',
  },
  SESSION_REQUIRED: {
    status: 401,
    message: 'Inicia sesión para continuar.',
  },
  ADMIN_USER_ID_UNAUTHORIZED: {
    status: 401,
    message: 'No autorizado para solicitar una sesión por usuarioId.',
  },
  API_TOKEN_FORBIDDEN: {
    status: 403,
    message: 'Solo los usuarios con sesión activa disponen de API token para el agente de IA.',
  },
  INVALID_ACCESS_CODE_FORMAT: {
    status: 400,
    message: 'Se requiere un código de acceso válido.',
  },
  INVALID_OR_USED_ACCESS_CODE: {
    status: 401,
    message: 'El código no es válido o ya fue utilizado.',
  },
  SESSION_ACTIVATION_FAILED: {
    status: 503,
    message: 'No se pudo activar la sesión.',
  },
  INVALID_RECOVERY_TOKEN_FORMAT: {
    status: 400,
    message: 'Se requiere un token de recuperación válido.',
  },
  INVALID_OR_REVOKED_RECOVERY_TOKEN: {
    status: 401,
    message: 'El token de recuperación no es válido o la sesión fue revocada.',
  },
  SESSION_RECOVERY_FAILED: {
    status: 503,
    message: 'No se pudo recuperar la sesión.',
  },
  RESET_EMAIL_REQUIRED: {
    status: 400,
    message: 'Debes indicar tu correo electrónico para recibir el código de verificación.',
  },
  CONFIRM_EMAIL_REQUIRED: {
    status: 400,
    message: 'Debes indicar tu correo electrónico.',
  },
  USER_EMAIL_NOT_FOUND: {
    status: 404,
    message: 'No se ha encontrado ningún usuario con ese correo electrónico.',
  },
  RESET_CODE_INVALID_FORMAT: {
    status: 400,
    message: 'El código de verificación debe tener 6 dígitos numéricos.',
  },
  RESET_CODE_EXPIRED_OR_MISSING: {
    status: 400,
    message: 'No hay ningún código pendiente o el código ha caducado. Solicita uno nuevo.',
  },
  RESET_CODE_TOO_MANY_ATTEMPTS: {
    status: 429,
    message: 'Has superado el máximo de intentos. Solicita un nuevo código de verificación.',
  },
  RESET_CODE_INCORRECT: {
    status: 401,
    message: ({ remainingAttempts }) =>
      `El código numérico no es correcto. Te quedan ${remainingAttempts} intentos.`,
  },
  SESSION_REQUEST_FAILED: {
    status: 503,
    message: 'No se pudo procesar la verificación de solicitud de sesión.',
  },
  SESSION_CONFIRM_FAILED: {
    status: 503,
    message: 'No se pudo confirmar la solicitud de sesión.',
  },
  VALID_USER_ID_REQUIRED: {
    status: 400,
    message: 'Se requiere un usuarioId válido.',
  },
  INVITATION_ALREADY_IN_PROCESS: {
    status: 409,
    message: 'El usuario ya tiene una invitación en proceso.',
    body: () => ({ yaEnProceso: true, enviada: false }),
  },
  INVITATION_SEND_FAILED: {
    status: 503,
    message: 'No se pudo enviar la invitación. Revisa la configuración de correo.',
  },
  RATE_LIMIT_EXCEEDED: {
    status: 429,
    message: ({ message } = {}) => message || 'Demasiadas peticiones.',
    body: ({ retryAfterSeconds } = {}) => (retryAfterSeconds ? { retryAfterSeconds } : {}),
    headers: ({ retryAfterSeconds } = {}) =>
      retryAfterSeconds ? { 'Retry-After': String(retryAfterSeconds) } : {},
  },

  // Usuarios
  USER_NOT_FOUND: {
    status: 404,
    message: 'Usuario no encontrado.',
  },
  USER_MISSING_REQUIRED_FIELDS: {
    status: 400,
    message: ({ fields }) => `Se requieren estos campos: ${fields.join(', ')}.`,
  },
  USER_EMPTY_FIELD: {
    status: 400,
    message: ({ field }) => `El campo ${field} no puede estar vacío.`,
  },
  USER_INVALID_EMAIL: {
    status: 400,
    message: 'El email no tiene un formato válido.',
  },
  USER_DUPLICATE_CODE: {
    status: 409,
    message: 'Ya existe un usuario con ese código.',
  },
  USER_DUPLICATE_EMAIL: {
    status: 409,
    message: 'Ya existe un usuario con ese email.',
  },
  USER_OFFICE_NOT_FOUND: {
    status: 400,
    message: 'La oficina seleccionada no existe.',
  },
  USER_INVALID_DATA: {
    status: 400,
    message: 'Los datos del usuario no son válidos.',
  },

  // Equipos
  TEAM_NOT_FOUND: {
    status: 404,
    message: 'Equipo no encontrado.',
  },
  TEAM_NAME_REQUIRED: {
    status: 400,
    message: 'El nombre del equipo es obligatorio.',
  },
  TEAM_NAME_EMPTY: {
    status: 400,
    message: 'El nombre del equipo no puede estar vacío.',
  },
  TEAM_INVALID_NAME: {
    status: 400,
    message: 'El nombre del equipo no es válido (máximo 120 caracteres).',
  },
  TEAM_DUPLICATE: {
    status: 409,
    message: 'Ya existe un equipo con ese nombre.',
  },
  TEAM_DUPLICATE_OTHER: {
    status: 409,
    message: 'Ya existe otro equipo con ese nombre.',
  },

  // Oficinas y Calendarios
  OFFICE_NOT_FOUND: {
    status: 404,
    message: 'Oficina no encontrada.',
  },
  OFFICE_NAME_REQUIRED: {
    status: 400,
    message: 'El nombre de la oficina es obligatorio.',
  },
  OFFICE_NAME_EMPTY: {
    status: 400,
    message: 'El nombre de la oficina no puede estar vacío.',
  },
  OFFICE_INVALID_NAME: {
    status: 400,
    message: 'El nombre de la oficina no es válido (máximo 120 caracteres).',
  },
  OFFICE_DUPLICATE: {
    status: 409,
    message: 'Ya existe una oficina con ese nombre.',
  },
  OFFICE_DUPLICATE_OTHER: {
    status: 409,
    message: 'Ya existe otra oficina con ese nombre.',
  },
  OFFICE_CALENDAR_INVALID_YEAR: {
    status: 400,
    message: 'El año del calendario debe estar entre 1900 y 2200.',
  },
  OFFICE_CALENDAR_NOT_FOUND: {
    status: 404,
    message: 'Calendario anual no encontrado para esta oficina.',
  },
  OFFICE_HOLIDAY_INVALID: {
    status: 400,
    message: 'Indica una fecha válida (YYYY-MM-DD) y un nombre de festivo (máximo 120 caracteres).',
  },
  OFFICE_HOLIDAY_YEAR_MISMATCH: {
    status: 400,
    message: 'La fecha seleccionada no corresponde al año del calendario indicado.',
  },
  OFFICE_HOLIDAY_DUPLICATE: {
    status: 409,
    message: 'Ya existe un día festivo registrado en esa fecha para esta oficina.',
  },
  OFFICE_HOLIDAY_NOT_FOUND: {
    status: 404,
    message: 'Día festivo no encontrado para esta oficina.',
  },

  // Vacaciones
  VACATION_ADMIN_USER_ID_REQUIRED: {
    status: 400,
    message: 'El administrador debe indicar un usuarioId válido.',
  },
  VACATION_OTHER_USER_FORBIDDEN: {
    status: 403,
    message: 'Solo el administrador puede indicar otro usuarioId.',
  },
  VACATION_INVALID_DATES_LIST: {
    status: 400,
    message: 'fechas debe ser una lista de 1 a 366 fechas válidas con formato YYYY-MM-DD.',
  },
  VACATION_CREATE_HOLIDAY_CONFLICT: {
    status: 400,
    message: ({ holidays }) =>
      `No se pueden registrar vacaciones en días festivos de la oficina asignada: ${holidays
        .map((h) => `${h.fecha} (${h.nombre})`)
        .join(', ')}.`,
    body: ({ holidays }) => ({ festivos: holidays }),
  },
  VACATION_INVALID_DATE_FORMAT: {
    status: 400,
    message: 'La nueva fecha debe tener formato válido YYYY-MM-DD.',
  },
  VACATION_PAST_TARGET_DATE: {
    status: 400,
    message: 'No puedes cambiar un día de vacaciones a una fecha que ya ha pasado.',
  },
  VACATION_NOT_FOUND: {
    status: 404,
    message: 'Día de vacaciones no encontrado.',
  },
  VACATION_UPDATE_FORBIDDEN: {
    status: 403,
    message: 'No tienes permiso para modificar este día de vacaciones.',
  },
  VACATION_UPDATE_PAST_DATE: {
    status: 400,
    message: 'No se pueden modificar días de vacaciones cuya fecha ya ha pasado.',
  },
  VACATION_UPDATE_HOLIDAY_CONFLICT: {
    status: 400,
    message: ({ fecha, holiday }) =>
      `No puedes mover las vacaciones al ${fecha} porque es día festivo en tu oficina (${holiday.nombre}).`,
    body: ({ holiday, includeHolidayInBody }) =>
      includeHolidayInBody ? { festivo: holiday } : {},
  },
  VACATION_DUPLICATE: {
    status: 409,
    message: 'Ya tienes registrado ese día de vacaciones.',
  },
  VACATION_DELETE_FORBIDDEN: {
    status: 403,
    message: 'No tienes permiso para eliminar este día de vacaciones.',
  },
  VACATION_DELETE_PAST_DATE: {
    status: 400,
    message: 'No se pueden eliminar días de vacaciones cuya fecha ya ha pasado.',
  },
};

/** @typedef {keyof typeof ERROR_CATALOG} ErrorKey */

/**
 * Error de dominio controlado cuya respuesta HTTP/MCP se resuelve a partir de ERROR_CATALOG.
 */
export class AppError extends Error {
  /**
   * @param {ErrorKey} key
   * @param {Record<string, any>} [params]
   */
  constructor(key, params = {}) {
    const def = ERROR_CATALOG[key];
    if (!def) {
      throw new Error(`Clave de error desconocida en ERROR_CATALOG: ${String(key)}`);
    }
    const resolvedMessage = typeof def.message === 'function' ? def.message(params) : def.message;
    super(resolvedMessage, params?.cause ? { cause: params.cause } : undefined);
    this.name = 'AppError';
    this.key = key;
    this.statusCode = def.status;
    this.params = params;
    this.extraBody = def.body ? def.body(params) : {};
    this.headers = def.headers ? def.headers(params) : {};
  }
}

/**
 * Factoría para construir un AppError a partir de una clave del catálogo.
 * @param {ErrorKey} key
 * @param {Record<string, any>} [params]
 * @returns {AppError}
 */
export function appError(key, params) {
  return new AppError(key, params);
}

/** @type {Record<string, Record<string, (err: any) => AppError>>} */
export const PG_ERROR_HANDLERS = {
  user: {
    '23505': (err) => {
      const isCode = String(err.constraint || err.detail || '')
        .toLowerCase()
        .includes('codigo');
      return appError(isCode ? 'USER_DUPLICATE_CODE' : 'USER_DUPLICATE_EMAIL');
    },
    '23503': () => appError('USER_OFFICE_NOT_FOUND'),
    '23514': () => appError('USER_INVALID_DATA'),
  },
  vacation: {
    '23503': () => appError('USER_NOT_FOUND'),
    '23505': () => appError('VACATION_DUPLICATE'),
  },
};

/**
 * Convierte errores conocidos de PostgreSQL en AppError según el dominio o los relanza.
 * @param {any} error
 * @param {'user' | 'vacation'} domain
 * @returns {never}
 */
export function rethrowPgError(error, domain) {
  const handler = PG_ERROR_HANDLERS[domain]?.[error?.code];
  if (handler) {
    throw handler(error);
  }
  throw error;
}
