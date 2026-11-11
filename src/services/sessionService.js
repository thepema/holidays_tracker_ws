import pool from '../db.js';
import { generateToken, hashToken } from '../lib/security.js';
import { notifyAdminSessionRequest, sendLoginEmail } from './emailService.js';

export async function requestNewSession(user) {
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

export async function issueInvitation(user) {
  return requestNewSession(user);
}

export async function inviteUsersWithoutActiveSession(users) {
  const results = { sent: 0, failed: 0, skipped: 0 };
  for (const user of users) {
    try {
      const res = await issueInvitation(user);
      if (res?.alreadyInProcess) {
        results.skipped += 1;
      } else {
        results.sent += 1;
      }
    } catch {
      results.failed += 1;
    }
  }
  return results;
}

export async function activateSession(code) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT u.id, s.usuario_id, u.nombre, u.apellidos, u.email, u.cargo, u.tipo_vacaciones
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
       WHERE (s.request_token_hash = $1 OR s.request_token_hash = $2)
         AND s.estado = 'proceso' FOR UPDATE OF s`,
      [code, hashToken(code)],
    );
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const user = found.rows[0];
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
      ? `SELECT u.id, s.usuario_id, u.nombre, u.apellidos, u.email, u.cargo, u.tipo_vacaciones
         FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
         WHERE LOWER(u.email) = LOWER($3)
           AND (s.recovery_token_hash = $1 OR s.recovery_token_hash = $2)
           AND s.estado = 'autorizado' FOR UPDATE OF s`
      : `SELECT u.id, s.usuario_id, u.nombre, u.apellidos, u.email, u.cargo, u.tipo_vacaciones
         FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
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

    const user = found.rows[0];
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
    `SELECT id, nombre, apellidos, email, cargo, tipo_vacaciones
     FROM usuarios WHERE id = $1`,
    [rows[0].usuario_id],
  );
  return userResult.rows[0] || null;
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
