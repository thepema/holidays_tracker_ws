import pool from '../db.js';

function parseDates(dates) {
  if (!Array.isArray(dates) || dates.length < 1 || dates.length > 366) return null;
  const unique = new Set();
  for (const value of dates) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
    const date = new Date(`${value}T00:00:00.000Z`);
    if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) return null;
    unique.add(value);
  }
  return [...unique];
}

export async function createVacations(userId, inputDates) {
  const dates = parseDates(inputDates);
  if (!dates) return { invalid: true };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const inserted = [];
    for (const date of dates) {
      const year = Number(date.slice(0, 4));
      const { rows } = await client.query(
        `INSERT INTO vacaciones (usuario_id, anio, fecha)
         VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, fecha) DO NOTHING
         RETURNING id, usuario_id AS "usuarioId", anio, fecha`,
        [userId, year, date],
      );
      inserted.push(...rows);
    }
    await client.query('COMMIT');
    return { invalid: false, inserted };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listVacations(userIds = null) {
  const filter = Array.isArray(userIds) && userIds.length > 0 ? userIds : null;
  const { rows } = await pool.query(
    `SELECT id, usuario_id AS "usuarioId", anio, fecha
     FROM vacaciones
     WHERE $1::bigint[] IS NULL OR usuario_id = ANY($1::bigint[])
     ORDER BY fecha ASC, id ASC`,
    [filter],
  );
  return rows;
}
