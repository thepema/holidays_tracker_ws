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

function normalizeSqlDate(rawDate) {
  if (rawDate instanceof Date && !Number.isNaN(rawDate.getTime())) {
    const adjusted = new Date(rawDate.getTime() + 3 * 60 * 60 * 1000);
    return adjusted.toISOString().slice(0, 10);
  }
  const str = String(rawDate || '').trim();
  return str.slice(0, 10);
}

function getTodayDateKey() {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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

export async function updateVacationDate(vacationId, userId, newDateRaw, isAdmin = false) {
  const parsed = parseDates([newDateRaw]);
  if (!parsed || parsed.length !== 1) {
    return { invalid: true };
  }
  const newDate = parsed[0];
  const todayKey = getTodayDateKey();

  if (!isAdmin && newDate < todayKey) {
    return { pastTargetDate: true };
  }

  const { rows: existingRows } = await pool.query(
    `SELECT id, usuario_id AS "usuarioId", anio, fecha
     FROM vacaciones
     WHERE id = $1`,
    [vacationId],
  );
  const existing = existingRows[0];
  if (!existing) {
    return { notFound: true };
  }

  if (!isAdmin && Number(existing.usuarioId) !== Number(userId)) {
    return { forbidden: true };
  }

  const currentFecha = normalizeSqlDate(existing.fecha);
  if (!isAdmin && currentFecha < todayKey) {
    return { pastDate: true };
  }

  const newYear = Number(newDate.slice(0, 4));
  try {
    const { rows } = await pool.query(
      `UPDATE vacaciones
       SET fecha = $1, anio = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, usuario_id AS "usuarioId", anio, fecha`,
      [newDate, newYear, vacationId],
    );
    return { updated: rows[0] };
  } catch (error) {
    if (error.code === '23505') {
      return { duplicate: true };
    }
    throw error;
  }
}

export async function deleteVacation(vacationId, userId, isAdmin = false) {
  const todayKey = getTodayDateKey();
  const { rows: existingRows } = await pool.query(
    `SELECT id, usuario_id AS "usuarioId", anio, fecha
     FROM vacaciones
     WHERE id = $1`,
    [vacationId],
  );
  const existing = existingRows[0];
  if (!existing) {
    return { notFound: true };
  }

  if (!isAdmin && Number(existing.usuarioId) !== Number(userId)) {
    return { forbidden: true };
  }

  const currentFecha = normalizeSqlDate(existing.fecha);
  if (!isAdmin && currentFecha < todayKey) {
    return { pastDate: true };
  }

  await pool.query(`DELETE FROM vacaciones WHERE id = $1`, [vacationId]);
  return { deleted: true, id: Number(vacationId) };
}
