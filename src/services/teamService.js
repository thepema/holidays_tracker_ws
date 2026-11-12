import pool from '../db.js';

function normalizeIdList(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  const unique = new Set();
  for (const item of rawIds) {
    const id = Number(typeof item === 'object' && item !== null ? item.id : item);
    if (Number.isInteger(id) && id > 0) {
      unique.add(id);
    }
  }
  return [...unique];
}

function mapTeamRow(row) {
  if (!row) return null;
  const rawUserIds = Array.isArray(row.usuario_ids) ? row.usuario_ids : [];
  const usuarioIds = rawUserIds
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  return {
    id: Number(row.id),
    nombre: String(row.nombre || '').trim(),
    usuarioIds,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listTeams() {
  const { rows } = await pool.query(
    `SELECT e.id,
            e.nombre,
            e.created_at,
            e.updated_at,
            COALESCE(
              ARRAY_AGG(ue.usuario_id ORDER BY ue.usuario_id) FILTER (WHERE ue.usuario_id IS NOT NULL),
              '{}'
            ) AS usuario_ids
     FROM equipos e
     LEFT JOIN usuarios_equipos ue ON ue.equipo_id = e.id
     GROUP BY e.id, e.nombre, e.created_at, e.updated_at
     ORDER BY LOWER(TRIM(e.nombre)) ASC, e.id ASC`,
  );
  return rows.map(mapTeamRow);
}

export async function findTeamById(equipoId, client = pool) {
  const { rows } = await client.query(
    `SELECT e.id,
            e.nombre,
            e.created_at,
            e.updated_at,
            COALESCE(
              ARRAY_AGG(ue.usuario_id ORDER BY ue.usuario_id) FILTER (WHERE ue.usuario_id IS NOT NULL),
              '{}'
            ) AS usuario_ids
     FROM equipos e
     LEFT JOIN usuarios_equipos ue ON ue.equipo_id = e.id
     WHERE e.id = $1
     GROUP BY e.id, e.nombre, e.created_at, e.updated_at`,
    [equipoId],
  );
  return mapTeamRow(rows[0]);
}

export async function setTeamUsers(equipoId, rawUsuarioIds, client = pool) {
  const usuarioIds = normalizeIdList(rawUsuarioIds);
  await client.query(`DELETE FROM usuarios_equipos WHERE equipo_id = $1`, [equipoId]);
  if (usuarioIds.length > 0) {
    await client.query(
      `INSERT INTO usuarios_equipos (usuario_id, equipo_id)
       SELECT u.id, $1
       FROM usuarios u
       WHERE u.id = ANY($2::bigint[])
       ON CONFLICT (usuario_id, equipo_id) DO NOTHING`,
      [equipoId, usuarioIds],
    );
  }
}

export async function setUserTeams(usuarioId, rawEquipoIds, client = pool) {
  const equipoIds = normalizeIdList(rawEquipoIds);
  await client.query(`DELETE FROM usuarios_equipos WHERE usuario_id = $1`, [usuarioId]);
  if (equipoIds.length > 0) {
    await client.query(
      `INSERT INTO usuarios_equipos (usuario_id, equipo_id)
       SELECT $1, e.id
       FROM equipos e
       WHERE e.id = ANY($2::bigint[])
       ON CONFLICT (usuario_id, equipo_id) DO NOTHING`,
      [usuarioId, equipoIds],
    );
  }
}

export async function createTeam({ nombre, usuarioIds }) {
  const cleanName = String(nombre || '').trim();
  if (!cleanName || cleanName.length > 120) {
    return { invalid: true };
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: dupRows } = await client.query(
      `SELECT id FROM equipos WHERE LOWER(TRIM(nombre)) = LOWER($1) LIMIT 1`,
      [cleanName],
    );
    if (dupRows[0]) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }

    const { rows } = await client.query(
      `INSERT INTO equipos (nombre)
       VALUES ($1)
       RETURNING id`,
      [cleanName],
    );
    const createdId = rows[0].id;

    if (Array.isArray(usuarioIds)) {
      await setTeamUsers(createdId, usuarioIds, client);
    }

    const team = await findTeamById(createdId, client);
    await client.query('COMMIT');
    return { team };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      return { duplicate: true };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateTeam(equipoId, { nombre, usuarioIds }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await findTeamById(equipoId, client);
    if (!existing) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }

    if (nombre !== undefined) {
      const cleanName = String(nombre || '').trim();
      if (!cleanName || cleanName.length > 120) {
        await client.query('ROLLBACK');
        return { invalid: true };
      }

      const { rows: dupRows } = await client.query(
        `SELECT id FROM equipos WHERE LOWER(TRIM(nombre)) = LOWER($1) AND id <> $2 LIMIT 1`,
        [cleanName, equipoId],
      );
      if (dupRows[0]) {
        await client.query('ROLLBACK');
        return { duplicate: true };
      }

      await client.query(
        `UPDATE equipos
         SET nombre = $1, updated_at = NOW()
         WHERE id = $2`,
        [cleanName, equipoId],
      );
    }

    if (Array.isArray(usuarioIds)) {
      await setTeamUsers(equipoId, usuarioIds, client);
    }

    const updated = await findTeamById(equipoId, client);
    await client.query('COMMIT');
    return { team: updated };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      return { duplicate: true };
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteTeam(equipoId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT id FROM equipos WHERE id = $1`,
      [equipoId],
    );
    if (!existing[0]) {
      await client.query('ROLLBACK');
      return { notFound: true };
    }

    await client.query(`DELETE FROM usuarios_equipos WHERE equipo_id = $1`, [equipoId]);
    await client.query(`DELETE FROM equipos WHERE id = $1`, [equipoId]);
    await client.query('COMMIT');
    return { deleted: true, id: Number(equipoId) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
