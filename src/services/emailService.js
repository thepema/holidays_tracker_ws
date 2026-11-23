import nodemailer from 'nodemailer';
import { checkCooldown, checkRateLimit, markCooldown } from '../lib/rateLimiter.js';

export const DEFAULT_SMTP_HOST = 'smtp.buzondecorreo.com';
export const DEFAULT_SMTP_PORT = 465;
export const DEFAULT_MAIL_USER = 'generic@maisonzaro.com';
export const DEFAULT_MAIL_FROM = 'Holiday Tracker <generic@maisonzaro.com>';
export const DEFAULT_APP_URL = 'https://holiday-tracker.maisonzaro.com';

export const DEFAULT_IMAP_CONFIG = {
  host: process.env.IMAP_HOST || 'imap.buzondecorreo.com',
  port: Number(process.env.IMAP_PORT) || 993,
  secure: process.env.IMAP_SECURE !== 'false',
};

const GLOBAL_SMTP_WINDOW_MS = 60 * 1000;
const GLOBAL_SMTP_MAX_PER_MINUTE = 30;
const RECIPIENT_COOLDOWN_MS = 60 * 1000;
const ADMIN_EXPLICIT_COOLDOWN_MS = 15 * 1000;
const RECIPIENT_HOURLY_WINDOW_MS = 60 * 60 * 1000;
const RECIPIENT_MAX_PER_HOUR = 5;
const ADMIN_NOTIFY_USER_COOLDOWN_MS = 15 * 60 * 1000;

const EMAIL_FORMAT_REGEX = /^[^\s@<>()[\]\\,;:\s@"]+@[^\s@<>()[\]\\,;:\s"]+\.[^\s@<>()[\]\\,;:\s"]{2,}$/;

let transporter;
let transporterConfigKey = '';

function parseBooleanFlag(rawValue, fallback) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }
  return ['true', '1', 'ssl', 'tls', 'yes'].includes(String(rawValue).trim().toLowerCase());
}

export function getAppBaseUrl() {
  const raw = String(process.env.APP_URL || DEFAULT_APP_URL).trim().replace(/\/+$/, '');
  const candidate = raw || DEFAULT_APP_URL;
  return /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
}

export function getMailConfig() {
  const host = String(process.env.MAIL_HOST || DEFAULT_SMTP_HOST).trim();
  const port = Number(process.env.MAIL_PORT) || DEFAULT_SMTP_PORT;
  const secure = parseBooleanFlag(process.env.MAIL_SECURE, port === 465);
  const user = String(process.env.MAIL_USER || DEFAULT_MAIL_USER).trim();
  const pass = String(process.env.MAIL_PASSWORD || '');
  const from = String(process.env.MAIL_FROM || DEFAULT_MAIL_FROM).trim();
  const adminEmail = String(process.env.ADMIN_EMAIL || DEFAULT_MAIL_USER).trim();
  const appUrl = getAppBaseUrl();

  return {
    host,
    port,
    secure,
    user,
    pass,
    from,
    adminEmail,
    appUrl,
    imap: {
      host: String(process.env.IMAP_HOST || 'imap.buzondecorreo.com').trim(),
      port: Number(process.env.IMAP_PORT) || 993,
      secure: parseBooleanFlag(process.env.IMAP_SECURE, true),
    },
  };
}

function createRateLimitError(message, retryAfterSeconds) {
  const error = new Error(message);
  error.statusCode = 429;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

export function validateEmailAddress(email) {
  const raw = String(email || '');
  if (/[\r\n\0]/.test(raw)) {
    const error = new Error('Dirección de correo inválida: contiene caracteres no permitidos.');
    error.statusCode = 400;
    throw error;
  }
  const normalized = raw.trim().toLowerCase();
  if (!normalized || normalized.length > 254 || !EMAIL_FORMAT_REGEX.test(normalized)) {
    const error = new Error('La dirección de correo electrónico no tiene un formato válido.');
    error.statusCode = 400;
    throw error;
  }
  return normalized;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function assertCanSendEmail(
  recipientEmail,
  { source = 'user', skipRecipientCooldown = false, skipRecipientHourlyLimit = false } = {},
) {
  const normalizedRecipient = validateEmailAddress(recipientEmail);
  if (source === 'admin' || source === 'internal') {
    return normalizedRecipient;
  }

  const cooldownMs = skipRecipientCooldown ? ADMIN_EXPLICIT_COOLDOWN_MS : RECIPIENT_COOLDOWN_MS;

  const recipientCooldown = checkCooldown({
    bucket: 'email:recipient-cooldown',
    key: normalizedRecipient,
  });
  if (!recipientCooldown.allowed) {
    throw createRateLimitError(
      `Ya se envió un correo recientemente a esta dirección. Espera ${recipientCooldown.retryAfterSeconds}s antes de reintentarlo.`,
      recipientCooldown.retryAfterSeconds,
    );
  }

  if (!skipRecipientHourlyLimit) {
    const recipientHourly = checkRateLimit({
      bucket: 'email:recipient-hourly',
      key: normalizedRecipient,
      maxRequests: RECIPIENT_MAX_PER_HOUR,
      windowMs: RECIPIENT_HOURLY_WINDOW_MS,
    });
    if (!recipientHourly.allowed) {
      throw createRateLimitError(
        `Se alcanzó el límite de correos por hora para este destinatario. Inténtalo de nuevo en ${recipientHourly.retryAfterSeconds}s.`,
        recipientHourly.retryAfterSeconds,
      );
    }
  }

  const globalLimit = checkRateLimit({
    bucket: 'email:smtp-global',
    key: 'global',
    maxRequests: GLOBAL_SMTP_MAX_PER_MINUTE,
    windowMs: GLOBAL_SMTP_WINDOW_MS,
  });
  if (!globalLimit.allowed) {
    throw createRateLimitError(
      `El servidor de correo está temporalmente saturado. Inténtalo de nuevo en ${globalLimit.retryAfterSeconds}s.`,
      globalLimit.retryAfterSeconds,
    );
  }

  markCooldown({
    bucket: 'email:recipient-cooldown',
    key: normalizedRecipient,
    cooldownMs,
  });

  return normalizedRecipient;
}

export function getTransporter() {
  const config = getMailConfig();
  if (!config.pass) {
    throw new Error('Falta configurar MAIL_PASSWORD para la cuenta de correo.');
  }

  const configKey = `${config.host}:${config.port}:${config.secure}:${config.user}:${config.pass}`;
  if (transporter && transporterConfigKey === configKey) {
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    auth: config.user ? { user: config.user, pass: config.pass } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    tls: {
      minVersion: 'TLSv1.2',
      servername: config.host,
    },
  });
  transporterConfigKey = configKey;
  return transporter;
}

export function resetEmailTransporter() {
  transporter = undefined;
  transporterConfigKey = '';
}

export async function sendLoginEmail(user, code) {
  const config = getMailConfig();
  const baseUrl = getAppBaseUrl();
  const loginUrl = `${baseUrl}/invitacion/${code}`;
  // Vía interna / enviada por el administrador: solo valida formato/seguridad, sin restricción de limitador.
  const recipient = validateEmailAddress(user?.email);

  const fullName = `${user?.nombre || ''} ${user?.apellidos || ''}`.trim() || 'usuario';
  const safeName = escapeHtml(fullName);
  const safeUrl = escapeHtml(loginUrl);

  await getTransporter().sendMail({
    from: config.from,
    to: recipient,
    subject: 'Acceso a Holiday Tracker',
    text:
      `Hola ${fullName},\n\n` +
      `Usa este enlace para iniciar sesión en Holiday Tracker. El código es de un solo uso:\n` +
      `${loginUrl}\n\n` +
      `Si no esperabas este correo, puedes ignorarlo.`,
    html:
      `<div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5; max-width: 560px;">` +
      `<h2 style="color: #0e3345; margin-bottom: 12px;">Acceso a Holiday Tracker</h2>` +
      `<p>Hola <strong>${safeName}</strong>,</p>` +
      `<p>Usa este enlace para activar tu sesión. El código es personal y de un solo uso:</p>` +
      `<p style="margin: 20px 0;">` +
      `<a href="${safeUrl}" style="background-color: #0e3345; color: #ffffff; padding: 12px 20px; text-decoration: none; border-radius: 6px; display: inline-block;">Activar sesión</a>` +
      `</p>` +
      `<p style="font-size: 13px; color: #4b5563;">Si el botón no funciona, copia y pega esta dirección en tu navegador:<br /><a href="${safeUrl}">${safeUrl}</a></p>` +
      `<p style="font-size: 12px; color: #6b7280; margin-top: 24px;">Si no esperabas este correo, puedes ignorarlo.</p>` +
      `</div>`,
  });
}

export async function sendSessionResetVerificationEmail(user, numericCode) {
  const config = getMailConfig();
  // Vía solicitada por el usuario: restringida por cooldown, límite por destinatario y límite global.
  const recipient = assertCanSendEmail(user?.email, { source: 'user' });

  const fullName = `${user?.nombre || ''} ${user?.apellidos || ''}`.trim() || 'usuario';
  const safeName = escapeHtml(fullName);
  const safeCode = escapeHtml(numericCode);

  await getTransporter().sendMail({
    from: config.from,
    to: recipient,
    subject: 'Código de verificación para reseteo de sesión - Holiday Tracker',
    text:
      `Hola ${fullName},\n\n` +
      `Hemos recibido una solicitud para resetear y volver a solicitar tu sesión en Holiday Tracker.\n\n` +
      `Introduce este código numérico de 6 dígitos para confirmar la solicitud (caduca en 10 minutos):\n` +
      `${numericCode}\n\n` +
      `Si no has solicitado este cambio, ignora este correo: tu sesión actual no se modificará hasta que se introduzca este código.`,
    html:
      `<div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5; max-width: 560px;">` +
      `<h2 style="color: #0e3345; margin-bottom: 12px;">Verificación de solicitud de sesión</h2>` +
      `<p>Hola <strong>${safeName}</strong>,</p>` +
      `<p>Hemos recibido una solicitud para resetear y volver a solicitar tu sesión en Holiday Tracker.</p>` +
      `<p>Introduce este código numérico de 6 dígitos para confirmar la solicitud (caduca en <strong>10 minutos</strong>):</p>` +
      `<div style="font-size: 28px; font-weight: bold; letter-spacing: 6px; color: #0e3345; background: #f2f1ec; padding: 14px 20px; border-radius: 8px; display: inline-block; margin: 12px 0;">${safeCode}</div>` +
      `<p style="font-size: 12px; color: #6b7280; margin-top: 20px;">Si no has solicitado este cambio, ignora este correo: tu sesión actual no se modificará hasta que se introduzca este código.</p>` +
      `</div>`,
  });
}

export async function notifyAdminSessionRequest(user, { initiatedByAdmin = false } = {}) {
  const config = getMailConfig();
  const adminRecipient = validateEmailAddress(config.adminEmail);

  if (!initiatedByAdmin) {
    const userKey = String(user?.id || user?.email || 'unknown').trim().toLowerCase();

    const userNotifyCooldown = checkCooldown({
      bucket: 'email:admin-notify-user',
      key: userKey,
    });
    if (!userNotifyCooldown.allowed) {
      return { skipped: true, reason: 'cooldown' };
    }

    const globalLimit = checkRateLimit({
      bucket: 'email:smtp-global',
      key: 'global',
      maxRequests: GLOBAL_SMTP_MAX_PER_MINUTE,
      windowMs: GLOBAL_SMTP_WINDOW_MS,
    });
    if (!globalLimit.allowed) {
      return { skipped: true, reason: 'global-rate-limit' };
    }

    markCooldown({
      bucket: 'email:admin-notify-user',
      key: userKey,
      cooldownMs: ADMIN_NOTIFY_USER_COOLDOWN_MS,
    });
  }

  const fullName = `${user?.nombre || ''} ${user?.apellidos || ''}`.trim() || 'Usuario';
  const userEmail = String(user?.email || '').replace(/[\r\n\0]/g, '').trim();
  const safeName = escapeHtml(fullName);
  const safeEmail = escapeHtml(userEmail);

  await getTransporter().sendMail({
    from: config.from,
    to: adminRecipient,
    subject: 'Solicitud de nueva sesión - Holiday Tracker',
    text: `${fullName} (${userEmail}) ha solicitado una nueva sesión en Holiday Tracker.`,
    html:
      `<div style="font-family: Arial, sans-serif; color: #1f2937; line-height: 1.5; max-width: 560px;">` +
      `<h2 style="color: #0e3345; margin-bottom: 12px;">Solicitud de nueva sesión</h2>` +
      `<p><strong>${safeName}</strong> (${safeEmail}) ha solicitado una nueva sesión en Holiday Tracker.</p>` +
      `</div>`,
  });

  return { sent: true };
}
