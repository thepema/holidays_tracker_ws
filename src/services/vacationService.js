import pool from '../db.js';
import { findUserHolidayConflicts } from './officeService.js';

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
    const conflicts = await findUserHolidayConflicts(userId, dates, client);
    if (conflicts.length > 0) {
      await client.query('ROLLBACK');
      return { invalid: false, holidayConflict: true, holidays: conflicts };
    }
    const inserted = [];
    for (const date of dates) {
      const year = Number(date.slice(0, 4));
      const { rows } = await client.query(
        `INSERT INTO vacaciones (usuario_id, anio, fecha)
         VALUES ($1, $2, $3)
         ON CONFLICT (usuario_id, fecha) DO NOTHING
         RETURNING id, usuario_id AS "usuarioId", anio, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha`,
        [userId, year, date],
      );
      for (const row of rows) {
        inserted.push({
          id: Number(row.id),
          usuarioId: Number(row.usuarioId),
          anio: Number(row.anio),
          fecha: String(row.fecha || '').trim(),
        });
      }
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

const VACATION_USER_TEAMS_SUBQUERY = `COALESCE(
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

export async function listVacations(
  userIds = null,
  { anio = null, mes = null, equipoId = null, oficinaId = null } = {},
) {
  const filter = Array.isArray(userIds) && userIds.length > 0 ? userIds : null;
  const yearFilter = Number.isInteger(Number(anio)) && Number(anio) > 1900 ? Number(anio) : null;
  const monthFilter =
    Number.isInteger(Number(mes)) && Number(mes) >= 1 && Number(mes) <= 12 ? Number(mes) : null;
  const teamFilter =
    Number.isInteger(Number(equipoId)) && Number(equipoId) >= 1 ? Number(equipoId) : null;
  const officeFilter =
    Number.isInteger(Number(oficinaId)) && Number(oficinaId) >= 1 ? Number(oficinaId) : null;

  const conditions = [];
  const params = [];

  if (filter) {
    params.push(filter);
    conditions.push(`v.usuario_id = ANY($${params.length}::bigint[])`);
  }

  if (yearFilter !== null && monthFilter !== null) {
    params.push(yearFilter, monthFilter);
    const yIdx = params.length - 1;
    const mIdx = params.length;
    conditions.push(
      `v.fecha >= make_date($${yIdx}::int, $${mIdx}::int, 1) AND v.fecha < (make_date($${yIdx}::int, $${mIdx}::int, 1) + INTERVAL '1 month')`,
    );
  } else if (yearFilter !== null) {
    params.push(yearFilter);
    conditions.push(`v.anio = $${params.length}::int`);
  } else if (monthFilter !== null) {
    params.push(monthFilter);
    conditions.push(`EXTRACT(MONTH FROM v.fecha) = $${params.length}::int`);
  }

  if (teamFilter !== null) {
    params.push(teamFilter);
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM usuarios_equipos ue
        WHERE ue.usuario_id = v.usuario_id
          AND ue.equipo_id = $${params.length}::bigint
      )`,
    );
  }

  if (officeFilter !== null) {
    params.push(officeFilter);
    conditions.push(`u.oficina_id = $${params.length}::bigint`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await pool.query(
    `SELECT v.id,
            v.usuario_id AS "usuarioId",
            v.anio,
            TO_CHAR(v.fecha, 'YYYY-MM-DD') AS fecha,
            u.codigo,
            u.nombre,
            u.apellidos,
            u.email,
            u.cargo,
            u.oficina_id AS "oficinaId",
            o.nombre AS "oficinaNombre",
            ${VACATION_USER_TEAMS_SUBQUERY}
     FROM vacaciones v
     LEFT JOIN usuarios u ON u.id = v.usuario_id
     LEFT JOIN oficinas o ON o.id = u.oficina_id
     ${whereClause}
     ORDER BY v.fecha ASC, u.nombre ASC, u.apellidos ASC, v.id ASC`,
    params,
  );
  return rows.map((row) => ({
    id: Number(row.id),
    usuarioId: Number(row.usuarioId),
    anio: Number(row.anio),
    fecha: String(row.fecha || '').trim(),
    ...(row.codigo ? { codigo: String(row.codigo).trim() } : {}),
    ...(row.nombre ? { nombre: String(row.nombre).trim() } : {}),
    ...(row.apellidos ? { apellidos: String(row.apellidos).trim() } : {}),
    ...(row.email ? { email: String(row.email).trim() } : {}),
    ...(row.cargo ? { cargo: String(row.cargo).trim() } : {}),
    oficinaId:
      row.oficinaId !== null && row.oficinaId !== undefined && Number(row.oficinaId) > 0
        ? Number(row.oficinaId)
        : null,
    oficinaNombre: row.oficinaNombre ? String(row.oficinaNombre).trim() : null,
    equipos: Array.isArray(row.equipos)
      ? row.equipos
          .map((item) => ({
            id: Number(item?.id),
            nombre: String(item?.nombre || '').trim(),
          }))
          .filter((item) => Number.isInteger(item.id) && item.id > 0 && item.nombre)
      : [],
  }));
}

export async function listVacationYears() {
  const { rows } = await pool.query(
    `SELECT DISTINCT anio
     FROM vacaciones
     WHERE anio > 1900
     ORDER BY anio DESC`,
  );
  return rows
    .map((row) => Number(row.anio))
    .filter((year) => Number.isInteger(year) && year > 1900);
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

  const conflicts = await findUserHolidayConflicts(existing.usuarioId, [newDate]);
  if (conflicts.length > 0) {
    return { holidayConflict: true, holiday: conflicts[0] };
  }

  const newYear = Number(newDate.slice(0, 4));
  try {
    const { rows } = await pool.query(
      `UPDATE vacaciones
       SET fecha = $1, anio = $2, updated_at = NOW()
       WHERE id = $3
       RETURNING id, usuario_id AS "usuarioId", anio, TO_CHAR(fecha, 'YYYY-MM-DD') AS fecha`,
      [newDate, newYear, vacationId],
    );
    const updatedRow = rows[0];
    return {
      updated: updatedRow
        ? {
            id: Number(updatedRow.id),
            usuarioId: Number(updatedRow.usuarioId),
            anio: Number(updatedRow.anio),
            fecha: String(updatedRow.fecha || '').trim(),
          }
        : null,
    };
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
