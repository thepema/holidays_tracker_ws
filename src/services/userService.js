import pool from '../db.js';
import { setUserTeams } from './teamService.js';

const USER_FIELDS = 'id, nombre, apellidos, cargo, email, tipo_vacaciones, created_at, updated_at';

const USER_TEAMS_SUBQUERY = `COALESCE(
  (
    SELECT json_agg(
      json_build_object('id', e.id, 'nombre', e.nombre)
      ORDER BY LOWER(TRIM(e.nombre)) ASC, e.id ASC
    )
    FROM usuarios_equipos ue
    INNER JOIN equipos e ON e.id = ue.equipo_id
    WHERE ue.usuario_id = u.id
  ),
  '[]'::json
) AS equipos`;

function mapUserWithTeams(row) {
  if (!row) return null;
  const rawEquipos = Array.isArray(row.equipos) ? row.equipos : [];
  const equipos = rawEquipos
    .map((item) => ({
      id: Number(item?.id),
      nombre: String(item?.nombre || '').trim(),
    }))
    .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.nombre);

  return {
    ...row,
    id: Number(row.id),
    equipos,
    equipoIds: equipos.map((e) => e.id),
  };
}

function extractRawTeamIds(input) {
  if (!input || typeof input !== 'object') return undefined;
  if (Array.isArray(input.equipoIds)) return input.equipoIds;
  if (Array.isArray(input.equipo_ids)) return input.equipo_ids;
  if (Array.isArray(input.equipos)) return input.equipos;
  return undefined;
}

export async function createUser(input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `INSERT INTO usuarios (nombre, apellidos, cargo, email, tipo_vacaciones)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        input.nombre.trim(),
        input.apellidos.trim(),
        input.cargo.trim(),
        input.email.trim().toLowerCase(),
        input.tipo_vacaciones.trim(),
      ],
    );
    const createdId = rows[0].id;

    const rawTeamIds = extractRawTeamIds(input);
    if (rawTeamIds !== undefined) {
      await setUserTeams(createdId, rawTeamIds, client);
    }

    const user = await findUserById(createdId, client);
    await client.query('COMMIT');
    return user;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function findUserById(id, client = pool) {
  const { rows } = await client.query(
    `SELECT u.id, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.created_at, u.updated_at,
            ${USER_TEAMS_SUBQUERY}
     FROM usuarios u
     WHERE u.id = $1`,
    [id],
  );
  return mapUserWithTeams(rows[0]);
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

  const rawTeamIds = extractRawTeamIds(updates);

  if (fields.length === 0 && rawTeamIds === undefined) {
    return findUserById(id);
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (fields.length > 0) {
      fields.push(`updated_at = NOW()`);
      values.push(id);
      await client.query(
        `UPDATE usuarios
         SET ${fields.join(', ')}
         WHERE id = $${index}`,
        values,
      );
    }

    if (rawTeamIds !== undefined) {
      await setUserTeams(id, rawTeamIds, client);
    }

    const updated = await findUserById(id, client);
    await client.query('COMMIT');
    return updated;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listNonAdminUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.created_at, u.updated_at,
            s.estado AS estado_sesion,
            ${USER_TEAMS_SUBQUERY}
     FROM usuarios u
     LEFT JOIN sesiones s ON s.usuario_id = u.id
     WHERE LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows.map(mapUserWithTeams);
}

export async function listUsersWithPendingInvitation() {
  const { rows } = await pool.query(
    `SELECT u.id, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.created_at, u.updated_at,
            s.estado AS estado_sesion,
            ${USER_TEAMS_SUBQUERY}
     FROM usuarios u
     INNER JOIN sesiones s ON s.usuario_id = u.id
     WHERE s.estado = 'proceso'
       AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows.map(mapUserWithTeams);
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
