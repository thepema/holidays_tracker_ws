import pool from '../db.js';
import { rethrowPgError } from '../lib/errors.js';
import { setUserTeams } from './teamService.js';

const USER_FIELDS = 'id, codigo, nombre, apellidos, cargo, email, tipo_vacaciones, oficina_id, created_at, updated_at';

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

const USER_CURRENT_YEAR_VACATIONS_SUBQUERY = `COALESCE(
  (
    SELECT COUNT(DISTINCT v.fecha)::int
    FROM vacaciones v
    WHERE v.usuario_id = u.id
      AND v.anio = EXTRACT(YEAR FROM CURRENT_DATE)::int
  ),
  0
) AS dias_vacaciones_anio_actual`;

function mapUserWithTeams(row) {
  if (!row) return null;
  const id = Number(row.id);
  if (!Number.isInteger(id) || id < 1) {
    return null;
  }

  const rawEquipos = Array.isArray(row.equipos) ? row.equipos : [];
  const equipos = rawEquipos
    .map((item) => ({
      id: Number(item?.id),
      nombre: String(item?.nombre || '').trim(),
    }))
    .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.nombre);
  const equipoIds = equipos.map((e) => e.id);

  const oficinaId =
    row.oficina_id !== null && row.oficina_id !== undefined && Number(row.oficina_id) > 0
      ? Number(row.oficina_id)
      : null;
  const oficinaNombre = row.oficina_nombre ? String(row.oficina_nombre).trim() : null;
  const estadoSesion = String(row.estado_sesion ?? '').trim().toLowerCase();
  const sesionActiva = estadoSesion === 'autorizado';
  const solicitudPendiente = estadoSesion === 'solicitado';
  const rawYearCount = Number(row.dias_vacaciones_anio_actual ?? 0);
  const diasVacacionesAnioActual =
    Number.isFinite(rawYearCount) && rawYearCount >= 0 ? Math.trunc(rawYearCount) : 0;

  return {
    id,
    codigo: String(row.codigo ?? '').trim(),
    nombre: String(row.nombre ?? '').trim(),
    apellidos: String(row.apellidos ?? '').trim(),
    cargo: String(row.cargo ?? '').trim(),
    email: String(row.email ?? '').trim(),
    tipo_vacaciones: String(row.tipo_vacaciones ?? '').trim(),
    oficinaId,
    oficinaNombre,
    oficina: oficinaId ? { id: oficinaId, nombre: oficinaNombre || '' } : null,
    equipos,
    equipoIds,
    estadoSesion,
    sesionActiva,
    solicitudPendiente,
    diasVacacionesAnioActual,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function extractRawTeamIds(input) {
  if (!input || typeof input !== 'object') return undefined;
  if (Array.isArray(input.equipoIds)) return input.equipoIds;
  if (Array.isArray(input.equipo_ids)) return input.equipo_ids;
  if (Array.isArray(input.equipos)) return input.equipos;
  return undefined;
}

function extractRawOfficeId(input) {
  if (!input || typeof input !== 'object') return undefined;
  const hasCamel = Object.prototype.hasOwnProperty.call(input, 'oficinaId');
  const hasSnake = Object.prototype.hasOwnProperty.call(input, 'oficina_id');
  if (!hasCamel && !hasSnake) return undefined;
  const raw = hasCamel ? input.oficinaId : input.oficina_id;
  if (raw === null || raw === '') return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function createUser(input) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const oficinaId = extractRawOfficeId(input) ?? null;
    const { rows } = await client.query(
      `INSERT INTO usuarios (codigo, nombre, apellidos, cargo, email, tipo_vacaciones, oficina_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [
        input.codigo.trim(),
        input.nombre.trim(),
        input.apellidos.trim(),
        input.cargo.trim(),
        input.email.trim().toLowerCase(),
        input.tipo_vacaciones.trim(),
        oficinaId,
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
    rethrowPgError(error, 'user');
  } finally {
    client.release();
  }
}

export async function findUserById(id, client = pool) {
  const { rows } = await client.query(
    `SELECT u.id, u.codigo, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.oficina_id,
            o.nombre AS oficina_nombre, u.created_at, u.updated_at,
            s.estado AS estado_sesion,
            ${USER_CURRENT_YEAR_VACATIONS_SUBQUERY},
            ${USER_TEAMS_SUBQUERY}
     FROM usuarios u
     LEFT JOIN oficinas o ON o.id = u.oficina_id
     LEFT JOIN sesiones s ON s.usuario_id = u.id
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

export async function updateUser(id, updates) {
  const fields = [];
  const values = [];
  let index = 1;

  if (updates.codigo !== undefined) {
    fields.push(`codigo = $${index++}`);
    values.push(updates.codigo.trim());
  }
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

  const rawOfficeId = extractRawOfficeId(updates);
  if (rawOfficeId !== undefined) {
    fields.push(`oficina_id = $${index++}`);
    values.push(rawOfficeId);
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
    rethrowPgError(error, 'user');
  } finally {
    client.release();
  }
}

export async function listNonAdminUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.codigo, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.oficina_id,
            o.nombre AS oficina_nombre, u.created_at, u.updated_at,
            s.estado AS estado_sesion,
            ${USER_CURRENT_YEAR_VACATIONS_SUBQUERY},
            ${USER_TEAMS_SUBQUERY}
     FROM usuarios u
     LEFT JOIN oficinas o ON o.id = u.oficina_id
     LEFT JOIN sesiones s ON s.usuario_id = u.id
      WHERE LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows.map(mapUserWithTeams).filter(Boolean);
}

export async function listUsersWithPendingInvitation() {
  const { rows } = await pool.query(
    `SELECT u.id, u.codigo, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.oficina_id,
            o.nombre AS oficina_nombre, u.created_at, u.updated_at,
            s.estado AS estado_sesion,
            ${USER_CURRENT_YEAR_VACATIONS_SUBQUERY},
            ${USER_TEAMS_SUBQUERY}
     FROM usuarios u
     LEFT JOIN oficinas o ON o.id = u.oficina_id
     INNER JOIN sesiones s ON s.usuario_id = u.id
     WHERE s.estado = 'proceso'
       AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows.map(mapUserWithTeams).filter(Boolean);
}

export async function listUsersWithRequestedSession() {
  const { rows } = await pool.query(
    `SELECT u.id, u.codigo, u.nombre, u.apellidos, u.cargo, u.email, u.tipo_vacaciones, u.oficina_id,
            o.nombre AS oficina_nombre, u.created_at, u.updated_at,
            s.estado AS estado_sesion,
            ${USER_CURRENT_YEAR_VACATIONS_SUBQUERY},
            ${USER_TEAMS_SUBQUERY}
     FROM usuarios u
     LEFT JOIN oficinas o ON o.id = u.oficina_id
     INNER JOIN sesiones s ON s.usuario_id = u.id
     WHERE s.estado = 'solicitado'
       AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows.map(mapUserWithTeams).filter(Boolean);
}

export async function getAdminSessionsSummary() {
  const [pendientes, solicitados, authCountResult] = await Promise.all([
    listUsersWithPendingInvitation(),
    listUsersWithRequestedSession(),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM usuarios u
       INNER JOIN sesiones s ON s.usuario_id = u.id
       WHERE s.estado = 'autorizado'
         AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')`,
    ),
  ]);

  const totalAutenticados = Number(authCountResult.rows[0]?.total ?? 0);
  return {
    pendientes,
    solicitados,
    totalPendientes: pendientes.length,
    totalSolicitados: solicitados.length,
    totalPendientesYSolicitados: pendientes.length + solicitados.length,
    totalAutenticados,
  };
}

export async function listUsersWithoutActiveSession() {
  const { rows } = await pool.query(
    `SELECT u.id, u.codigo, u.nombre, u.apellidos, u.email
     FROM usuarios u
     LEFT JOIN sesiones s ON s.usuario_id = u.id
     WHERE (s.usuario_id IS NULL OR s.estado NOT IN ('autorizado', 'proceso'))
       AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id`,
  );
  return rows;
}

export async function listAuthenticatedUsers() {
  const { rows } = await pool.query(
    `SELECT u.id, u.codigo, u.nombre, u.apellidos, u.email
     FROM usuarios u
     INNER JOIN sesiones s ON s.usuario_id = u.id
     WHERE s.estado = 'autorizado'
       AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
     ORDER BY u.id ASC`,
  );
  return rows;
}
