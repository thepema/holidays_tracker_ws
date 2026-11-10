import pool from '../db.js';
import { generateToken, hashToken } from '../lib/security.js';
import { notifyAdminSessionRequest, sendLoginEmail } from './emailService.js';

export async function issueInvitation(user) {
  const code = generateToken();
  const requestTokenHash = hashToken(code);
  const clearedSessionTokenHash = hashToken(generateToken());

  await pool.query(
    `INSERT INTO sesiones (usuario_id, token_hash, request_token_hash, recovery_token_hash, estado)
     VALUES ($1, $2, $3, NULL, 'proceso')
     ON CONFLICT (usuario_id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       request_token_hash = EXCLUDED.request_token_hash,
       recovery_token_hash = NULL,
       estado = 'proceso',
       updated_at = NOW()`,
    [user.id, clearedSessionTokenHash, requestTokenHash],
  );

  try {
    await sendLoginEmail(user, code);
  } catch (error) {
    await pool.query(
      `UPDATE sesiones SET estado = 'solicitado', request_token_hash = $1, updated_at = NOW()
       WHERE usuario_id = $2 AND request_token_hash = $3`,
      [hashToken(generateToken()), user.id, requestTokenHash],
    );
    throw error;
  }
}

export async function inviteUsersWithoutActiveSession(users) {
  const results = { sent: 0, failed: 0 };
  for (const user of users) {
    try {
      await issueInvitation(user);
      results.sent += 1;
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
      `SELECT s.usuario_id, u.nombre, u.apellidos, u.email
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
       WHERE s.request_token_hash = $1 AND s.estado = 'proceso' FOR UPDATE OF s`,
      [hashToken(code)],
    );
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const user = found.rows[0];
    const sessionToken = generateToken();
    const recoveryCode = generateToken();
    const invalidatedRequestTokenHash = hashToken(generateToken());

    await client.query(
      `UPDATE sesiones SET
         token_hash = $1,
         request_token_hash = $2,
         recovery_token_hash = $3,
         estado = 'autorizado',
         updated_at = NOW()
       WHERE usuario_id = $4`,
      [hashToken(sessionToken), invalidatedRequestTokenHash, hashToken(recoveryCode), user.usuario_id],
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

export async function recoverSession(email, recoveryCode) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query(
      `SELECT s.usuario_id, u.nombre, u.apellidos, u.email
       FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
       WHERE LOWER(u.email) = LOWER($1) AND s.recovery_token_hash = $2
         AND s.estado = 'autorizado' FOR UPDATE OF s`,
      [email.trim(), hashToken(recoveryCode)],
    );
    if (!found.rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }

    const user = found.rows[0];
    const token = generateToken();
    const nextRecoveryCode = generateToken();
    await client.query(
      `UPDATE sesiones SET
         token_hash = $1,
         recovery_token_hash = $2,
         estado = 'autorizado',
         updated_at = NOW()
       WHERE usuario_id = $3`,
      [hashToken(token), hashToken(nextRecoveryCode), user.usuario_id],
    );
    await client.query('COMMIT');

    return { token, user, recoveryCode: nextRecoveryCode };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function authenticateSession(token) {
  const { rows } = await pool.query(
    `UPDATE sesiones SET updated_at = NOW()
     WHERE token_hash = $1 AND estado = 'autorizado'
       AND updated_at > NOW() - INTERVAL '8 hours'
     RETURNING usuario_id`,
    [hashToken(token)],
  );
  if (!rows[0]) return null;
  const userResult = await pool.query(
    `SELECT id, nombre, apellidos, email, cargo, tipo_vacaciones
     FROM usuarios WHERE id = $1`,
    [rows[0].usuario_id],
  );
  return userResult.rows[0] || null;
}

export async function requestNewSession(user) {
  const placeholderTokenHash = hashToken(generateToken());
  const placeholderRequestTokenHash = hashToken(generateToken());
  await pool.query(
    `INSERT INTO sesiones (usuario_id, token_hash, request_token_hash, recovery_token_hash, estado)
     VALUES ($1, $2, $3, NULL, 'solicitado')
     ON CONFLICT (usuario_id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       request_token_hash = EXCLUDED.request_token_hash,
       recovery_token_hash = NULL,
       estado = 'solicitado',
       updated_at = NOW()`,
    [user.id, placeholderTokenHash, placeholderRequestTokenHash],
  );
  await notifyAdminSessionRequest(user);
}

export async function revokeSession(userId) {
  const placeholderTokenHash = hashToken(generateToken());
  const placeholderRequestTokenHash = hashToken(generateToken());
  await pool.query(
    `INSERT INTO sesiones (usuario_id, token_hash, request_token_hash, recovery_token_hash, estado)
     VALUES ($1, $2, $3, NULL, 'solicitado')
     ON CONFLICT (usuario_id) DO UPDATE SET
       token_hash = EXCLUDED.token_hash,
       request_token_hash = EXCLUDED.request_token_hash,
       recovery_token_hash = NULL,
       estado = 'solicitado',
       updated_at = NOW()`,
    [userId, placeholderTokenHash, placeholderRequestTokenHash],
  );
}
