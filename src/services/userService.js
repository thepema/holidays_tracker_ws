import pool from '../db.js';

const USER_FIELDS = 'id, nombre, apellidos, cargo, email, tipo_vacaciones, created_at, updated_at';

export async function createUser(input) {
  const { rows } = await pool.query(
    `INSERT INTO usuarios (nombre, apellidos, cargo, email, tipo_vacaciones)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${USER_FIELDS}`,
    [input.nombre.trim(), input.apellidos.trim(), input.cargo.trim(), input.email.trim().toLowerCase(), input.tipo_vacaciones.trim()],
  );
  return rows[0];
}

export async function findUserById(id) {
  const { rows } = await pool.query(
    `SELECT ${USER_FIELDS} FROM usuarios WHERE id = $1`,
    [id],
  );
  return rows[0] || null;
}

export async function findUserByEmail(email) {
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail) return null;
  const { rows } = await pool.query(
    `SELECT ${USER_FIELDS} FROM usuarios WHERE LOWER(TRIM(email)) = $1 LIMIT 1`,
    [cleanEmail],
  );
  return rows[0] || null;
}

export async function findUserByNameAndEmail(nombre, email) {
  const cleanName = String(nombre || '').trim().replace(/\s+/g, ' ');
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanName || !cleanEmail) return null;

  const { rows } = await pool.query(
    `SELECT ${USER_FIELDS}
     FROM usuarios
     WHERE LOWER(TRIM(email)) = $1
       AND (
         LOWER(TRIM(nombre)) = LOWER($2)
         OR LOWER(TRIM(nombre || ' ' || apellidos)) = LOWER($2)
         OR LOWER(TRIM(nombre || ' ' || apellidos)) LIKE LOWER($2) || ' %'
       )
     LIMIT 1`,
    [cleanEmail, cleanName],
  );
  return rows[0] || null;
}

export async function updateUser(id, updates) {
  const fields = [];
  const values = [];
  let index = 1;

  if (updates.nombre !== undefined) {
    fields.push(`nombre = $${index++}`);
    values.push(updates.nombre.trim());
  }
  if (updates.apellidos !== undefined) {
    fields.push(`apellidos = $${index++}`);
    values.push(updates.apellidos.trim());
  }
  if (updates.cargo !== undefined) {
    fields.push(`cargo = $${index++}`);
    values.push(updates.cargo.trim());
  }
  if (updates.email !== undefined) {
    fields.push(`email = $${index++}`);
    values.push(updates.email.trim().toLowerCase());
  }
  if (updates.tipo_vacaciones !== undefined) {
    fields.push(`tipo_vacaciones = $${index++}`);
    values.push(updates.tipo_vacaciones.trim());
  }

  if (fields.length === 0) {
    return findUserById(id);
  }

  fields.push(`updated_at = NOW()`);
  values.push(id);

  const { rows } = await pool.query(
    `UPDATE usuarios
     SET ${fields.join(', ')}
     WHERE id = $${index}
     RETURNING ${USER_FIELDS}`,
    values,
  );

  return rows[0] || null;
}

export async function listNonAdminUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.created_at, u.updated_at,
            s.estado AS estado_sesion
     FROM usuarios u
     LEFT JOIN sesiones s ON s.usuario_id = u.id
     WHERE LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows;
}

export async function listUsersWithPendingInvitation() {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.created_at, u.updated_at,
            s.estado AS estado_sesion
     FROM usuarios u
     INNER JOIN sesiones s ON s.usuario_id = u.id
     WHERE s.estado != 'autorizado'
       AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows;
}

export async function listUsersWithoutActiveSession() {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.apellidos, u.email
     FROM usuarios u
     LEFT JOIN sesiones s ON s.usuario_id = u.id
     WHERE (s.usuario_id IS NULL OR s.estado NOT IN ('autorizado', 'proceso'))
       AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id`,
  );
  return rows;
}
