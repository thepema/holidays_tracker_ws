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

export async function listUsersWithoutActiveSession() {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.apellidos, u.email
     FROM usuarios u
     LEFT JOIN sesiones s ON s.usuario_id = u.id
     WHERE s.usuario_id IS NULL OR s.estado <> 'autorizado'
     ORDER BY u.id`,
  );
  return rows;
}
