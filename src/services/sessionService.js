import crypto from 'node:crypto';
import pool from '../db.js';
import { checkRateLimit } from '../lib/rateLimiter.js';
import { generateToken, hashToken } from '../lib/security.js';
import {
  notifyAdminSessionRequest,
  sendLoginEmail,
  sendSessionResetVerificationEmail,
} from './emailService.js';

const RESET_CODE_TTL_MS = 10 * 60 * 1000;
const RESET_CODE_RESEND_COOLDOWN_MS = 60 * 1000;
const RESET_CODE_MAX_PER_HOUR = 5;
const MAX_RESET_CODE_ATTEMPTS = 5;
const BULK_INVITE_DELAY_MS = 250;
const pendingResetCodes = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createRateLimitError(message, retryAfterSeconds) {
  const error = new Error(message);
  error.statusCode = 429;
  error.retryAfterSeconds = retryAfterSeconds;
  return error;
}

export async function issueInvitation(user) {
  const { rows: currentSession } = await pool.query(
    `SELECT estado FROM sesiones WHERE usuario_id = $1`,
    [user.id],
  );

  if (currentSession[0]?.estado === 'proceso') {
    return { alreadyInProcess: true, sent: false };
  }

  const code = generateToken();
  const requestTokenHash = hashToken(code);

  try {
    await pool.query(
      `INSERT INTO sesiones (usuario_id, token_hash, request_token_hash, recovery_token_hash, estado)
       VALUES ($1, NULL, $2, NULL, 'proceso')
       ON CONFLICT (usuario_id) DO UPDATE SET
         token_hash = NULL,
         request_token_hash = EXCLUDED.request_token_hash,
         recovery_token_hash = NULL,
         estado = 'proceso',
         updated_at = NOW()`,
      [user.id, requestTokenHash],
    );
  } catch (error) {
    console.log('Error al crear o actualizar la sesión:', error);
    throw error;
  }

  try {
    await sendLoginEmail(user, requestTokenHash);
  } catch (error) {
    await pool.query(
      `UPDATE sesiones SET estado = 'solicitado', request_token_hash = NULL, updated_at = NOW()
       WHERE usuario_id = $1 AND request_token_hash = $2`,
      [user.id, requestTokenHash],
    );
    throw error;
  }

  return { code, sent: true };
}

export async function inviteUsersWithoutActiveSession(users) {
  const results = { sent: 0, failed: 0, skipped: 0 };
  for (let index = 0; index < users.length; index += 1) {
    const user = users[index];
    try {
      const res = await issueInvitation(user);
      if (res?.alreadyInProcess) {
        results.skipped += 1;
      } else {
        results.sent += 1;
        if (index < users.length - 1) {
          await sleep(BULK_INVITE_DELAY_MS);
        }
      }
    } catch {
      results.failed += 1;
    }
  }
  return results;
}

function mapSessionUser(row) {
  if (!row) return null;
  const rawOfficeId = row.oficinaId ?? row.oficina_id;
  const parsedOfficeId =
    rawOfficeId !== null && rawOfficeId !== undefined && Number(rawOfficeId) > 0
      ? Number(rawOfficeId)
      : null;
  const rawOfficeName = row.oficinaNombre ?? row.oficina_nombre;
  return {
    ...row,
    id: Number(row.id),
    ...(row.usuario_id !== undefined ? { usuario_id: Number(row.usuario_id) } : {}),
    codigo: String(row.codigo ?? '').trim(),
    oficinaId: Number.isInteger(parsedOfficeId) ? parsedOfficeId : null,
    oficinaNombre: rawOfficeName ? String(rawOfficeName).trim() : null,
  };
}

export async function activateSession(code) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT u.id, s.usuario_id, u.codigo, u.nombre, u.apellidos, u.email, u.cargo, u.tipo_vacaciones,
              u.oficina_id AS "oficinaId", o.nombre AS "oficinaNombre"
       FROM sesiones s
       JOIN usuarios u ON u.id = s.usuario_id
       LEFT JOIN oficinas o ON o.id = u.oficina_id
       WHERE (s.request_token_hash = $1 OR s.request_token_hash = $2)
         AND s.estado = 'proceso' FOR UPDATE OF s`,
      [code, hashToken(code)],
    );
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const user = mapSessionUser(found.rows[0]);
    const sessionToken = generateToken();
    const recoveryCode = generateToken();

    await client.query(
      `UPDATE sesiones SET
         token_hash = $1,
         request_token_hash = NULL,
         recovery_token_hash = $2,
         estado = 'autorizado',
         updated_at = NOW()
       WHERE usuario_id = $3`,
      [hashToken(sessionToken), hashToken(recoveryCode), user.usuario_id],
    );
    await client.query('COMMIT');

    return { token: sessionToken, user, recoveryCode };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function recoverSession(recoveryCode, email = '') {
  const cleanCode = String(recoveryCode || '').trim();
  const cleanEmail = String(email || '').trim();
  if (!cleanCode) return null;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const query = cleanEmail
      ? `SELECT u.id, s.usuario_id, u.codigo, u.nombre, u.apellidos, u.email, u.cargo, u.tipo_vacaciones,
                u.oficina_id AS "oficinaId", o.nombre AS "oficinaNombre"
         FROM sesiones s
         JOIN usuarios u ON u.id = s.usuario_id
         LEFT JOIN oficinas o ON o.id = u.oficina_id
         WHERE LOWER(u.email) = LOWER($3)
           AND (s.recovery_token_hash = $1 OR s.recovery_token_hash = $2)
           AND s.estado = 'autorizado' FOR UPDATE OF s`
      : `SELECT u.id, s.usuario_id, u.codigo, u.nombre, u.apellidos, u.email, u.cargo, u.tipo_vacaciones,
                u.oficina_id AS "oficinaId", o.nombre AS "oficinaNombre"
         FROM sesiones s
         JOIN usuarios u ON u.id = s.usuario_id
         LEFT JOIN oficinas o ON o.id = u.oficina_id
         WHERE (s.recovery_token_hash = $1 OR s.recovery_token_hash = $2)
           AND s.estado = 'autorizado' FOR UPDATE OF s`;
    const params = cleanEmail
      ? [hashToken(cleanCode), cleanCode, cleanEmail]
      : [hashToken(cleanCode), cleanCode];

    const found = await client.query(query, params);
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const user = mapSessionUser(found.rows[0]);
    const token = generateToken();
    await client.query(
      `UPDATE sesiones SET
         token_hash = $1,
         estado = 'autorizado',
         updated_at = NOW()
       WHERE usuario_id = $2`,
      [hashToken(token), user.usuario_id],
    );
    await client.query('COMMIT');

    return { token, user, recoveryCode: cleanCode };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function initiateSessionResetVerification(user) {
  const userId = Number(user.id);
  const now = Date.now();
  const existing = pendingResetCodes.get(userId);

  if (existing && existing.lastSentAt && now - existing.lastSentAt < RESET_CODE_RESEND_COOLDOWN_MS) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((RESET_CODE_RESEND_COOLDOWN_MS - (now - existing.lastSentAt)) / 1000),
    );
    throw createRateLimitError(
      `Debes esperar ${retryAfterSeconds}s antes de solicitar un nuevo código de verificación.`,
      retryAfterSeconds,
    );
  }

  const hourlyLimit = checkRateLimit({
    bucket: 'session:reset-code-user',
    key: String(userId),
    maxRequests: RESET_CODE_MAX_PER_HOUR,
    windowMs: 60 * 60 * 1000,
  });
  if (!hourlyLimit.allowed) {
    throw createRateLimitError(
      `Has alcanzado el máximo de solicitudes por hora. Podrás intentarlo de nuevo en ${hourlyLimit.retryAfterSeconds}s.`,
      hourlyLimit.retryAfterSeconds,
    );
  }

  const numericCode = String(crypto.randomInt(100000, 1000000));
  pendingResetCodes.set(userId, {
    codeHash: hashToken(numericCode),
    expiresAt: now + RESET_CODE_TTL_MS,
    lastSentAt: now,
    attempts: 0,
  });

  try {
    await sendSessionResetVerificationEmail(user, numericCode);
  } catch (error) {
    pendingResetCodes.delete(userId);
    throw error;
  }

  return {
    verificationSent: true,
    expiresInSeconds: Math.floor(RESET_CODE_TTL_MS / 1000),
    cooldownSeconds: Math.floor(RESET_CODE_RESEND_COOLDOWN_MS / 1000),
  };
}

export async function confirmSessionResetWithCode(user, rawCode) {
  const userId = Number(user.id);
  const code = String(rawCode || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return { invalidFormat: true };
  }

  const entry = pendingResetCodes.get(userId);
  if (!entry || Date.now() > entry.expiresAt) {
    pendingResetCodes.delete(userId);
    return { expiredOrMissing: true };
  }

  entry.attempts += 1;
  if (hashToken(code) !== entry.codeHash) {
    if (entry.attempts >= MAX_RESET_CODE_ATTEMPTS) {
      pendingResetCodes.delete(userId);
      return { tooManyAttempts: true };
    }
    return {
      invalidCode: true,
      remainingAttempts: MAX_RESET_CODE_ATTEMPTS - entry.attempts,
    };
  }

  pendingResetCodes.delete(userId);
  await markSessionAsRequested(user);
  return { confirmed: true, solicitado: true };
}

export async function markSessionAsRequested(user) {
  await pool.query(
    `INSERT INTO sesiones (usuario_id, token_hash, request_token_hash, recovery_token_hash, estado)
     VALUES ($1, NULL, NULL, NULL, 'solicitado')
     ON CONFLICT (usuario_id) DO UPDATE SET
       token_hash = NULL,
       request_token_hash = NULL,
       recovery_token_hash = NULL,
       estado = 'solicitado',
       updated_at = NOW()`,
    [user.id],
  );
  try {
    await notifyAdminSessionRequest(user);
  } catch {
    // Si el envío de correo no está configurado, se mantiene la solicitud registrada en BD.
  }
  return { requested: true, usuarioId: user.id };
}

export async function authenticateSession(token) {
  const { rows } = await pool.query(
    `UPDATE sesiones SET updated_at = NOW()
     WHERE (token_hash = $1 OR token_hash = $2) AND estado = 'autorizado'
     RETURNING usuario_id`,
    [hashToken(token), token],
  );
  if (!rows[0]) return null;
  const userResult = await pool.query(
    `SELECT u.id, u.codigo, u.nombre, u.apellidos, u.email, u.cargo, u.tipo_vacaciones,
            u.oficina_id AS "oficinaId", o.nombre AS "oficinaNombre"
     FROM usuarios u
     LEFT JOIN oficinas o ON o.id = u.oficina_id
     WHERE u.id = $1`,
    [rows[0].usuario_id],
  );
  return mapSessionUser(userResult.rows[0]);
}

export async function revokeSession(userId) {
  await pool.query(
    `INSERT INTO sesiones (usuario_id, token_hash, request_token_hash, recovery_token_hash, estado)
     VALUES ($1, '', '', NULL, 'solicitado')
     ON CONFLICT (usuario_id) DO UPDATE SET
       token_hash = '',
       request_token_hash = NULL,
       recovery_token_hash = NULL,
       estado = 'solicitado',
       updated_at = NOW()`,
    [userId],
  );
}
