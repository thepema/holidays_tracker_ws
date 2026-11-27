import pool from '../../shared/db.js';
import { appError } from '../../shared/errors.js';

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

function isValidDateKey(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

const OFFICE_SELECT_BASE = `
  SELECT o.id,
         o.nombre,
         o.created_at,
         o.updated_at,
         COALESCE(
           (
             SELECT ARRAY_AGG(u.id ORDER BY u.id)
             FROM usuarios u
             WHERE u.oficina_id = o.id
               AND LOWER(TRIM(u.cargo)) NOT IN ('administrador', 'administradora', 'admin')
           ),
           '{}'
         ) AS usuario_ids,
         COALESCE(
           (
             SELECT json_agg(
               json_build_object(
                 'id', co.id,
                 'oficinaId', co.oficina_id,
                 'anio', co.anio,
                 'festivos', COALESCE(
                   (
                     SELECT json_agg(
                       json_build_object(
                         'id', df.id,
                         'calendarioId', df.calendario_id,
                         'oficinaId', o.id,
                         'oficinaNombre', o.nombre,
                         'anio', co.anio,
                         'fecha', TO_CHAR(df.fecha, 'YYYY-MM-DD'),
                         'nombre', df.nombre
                       )
                       ORDER BY df.fecha ASC, df.id ASC
                     )
                     FROM dias_festivos df
                     WHERE df.calendario_id = co.id
                   ),
                   '[]'::json
                 )
               )
               ORDER BY co.anio DESC, co.id ASC
             )
             FROM calendarios_oficina co
             WHERE co.oficina_id = o.id
           ),
           '[]'::json
         ) AS calendarios
  FROM oficinas o
`;

function mapHolidayItem(item, fallbackOfficeId = 0, fallbackOfficeName = '', fallbackYear) {
  const id = Number(item?.id);
  const calendarioId = Number(item?.calendarioId ?? item?.calendario_id);
  const oficinaId = Number(item?.oficinaId ?? item?.oficina_id ?? fallbackOfficeId);
  const anio = Number(item?.anio ?? fallbackYear);
  const fecha = String(item?.fecha || '').trim().slice(0, 10);
  const nombre = String(item?.nombre || '').trim();
  const oficinaNombre = String(item?.oficinaNombre ?? item?.oficina_nombre ?? fallbackOfficeName ?? '').trim();

  if (!Number.isInteger(id) || id < 1 || !isValidDateKey(fecha) || !nombre) {
    return null;
  }

  return {
    id,
    calendarioId: Number.isInteger(calendarioId) && calendarioId > 0 ? calendarioId : 0,
    oficinaId: Number.isInteger(oficinaId) && oficinaId > 0 ? oficinaId : fallbackOfficeId,
    oficinaNombre,
    anio: Number.isInteger(anio) && anio > 1900 ? anio : Number(fecha.slice(0, 4)),
    fecha,
    nombre,
  };
}

function mapOfficeRow(row) {
  if (!row) return null;
  const officeId = Number(row.id);
  const officeName = String(row.nombre || '').trim();
  if (!Number.isInteger(officeId) || officeId < 1 || !officeName) {
    return null;
  }
  const rawUserIds = Array.isArray(row.usuario_ids) ? row.usuario_ids : [];
  const usuarioIds = [
    ...new Set(
      rawUserIds
        .map((id) => Number(id))
        .filter((id) => Number.isInteger(id) && id > 0),
    ),
  ];

  const rawCalendars = Array.isArray(row.calendarios) ? row.calendarios : [];
  const calendarios = rawCalendars
    .map((cal) => {
      const calId = Number(cal?.id);
      const anio = Number(cal?.anio);
      if (!Number.isInteger(calId) || calId < 1 || !Number.isInteger(anio) || anio < 1900) {
        return null;
      }
      const rawFestivos = Array.isArray(cal?.festivos) ? cal.festivos : [];
      const festivos = rawFestivos
        .map((f) => mapHolidayItem(f, officeId, officeName, anio))
        .filter(Boolean)
        .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id);

      return {
        id: calId,
        oficinaId: officeId,
        anio,
        festivos,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.anio - a.anio || a.id - b.id);

  const festivos = calendarios
    .flatMap((cal) => cal.festivos)
    .sort((a, b) => a.fecha.localeCompare(b.fecha) || a.id - b.id);

  return {
    id: officeId,
    nombre: officeName,
    usuarioIds,
    calendarios,
    festivos,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export async function listOffices(client = pool) {
  const { rows } = await client.query(
    `${OFFICE_SELECT_BASE}
     ORDER BY LOWER(TRIM(o.nombre)) ASC, o.id ASC`,
  );
  return rows.map(mapOfficeRow).filter(Boolean);
}

export async function findOfficeById(oficinaId, client = pool) {
  const { rows } = await client.query(
    `${OFFICE_SELECT_BASE}
     WHERE o.id = $1`,
    [oficinaId],
  );
  return mapOfficeRow(rows[0]);
}

export async function setOfficeUsers(oficinaId, rawUsuarioIds, client = pool) {
  const usuarioIds = normalizeIdList(rawUsuarioIds);
  await client.query(
    `UPDATE usuarios
     SET oficina_id = NULL, updated_at = NOW()
     WHERE oficina_id = $1`,
    [oficinaId],
  );
  if (usuarioIds.length > 0) {
    await client.query(
      `UPDATE usuarios
       SET oficina_id = $1, updated_at = NOW()
       WHERE id = ANY($2::bigint[])`,
      [oficinaId, usuarioIds],
    );
  }
}

export async function createOffice({ nombre, usuarioIds }) {
  const cleanName = String(nombre || '').trim();
  if (!cleanName || cleanName.length > 120) {
    throw appError('OFFICE_INVALID_NAME');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: dupRows } = await client.query(
      `SELECT id FROM oficinas WHERE LOWER(TRIM(nombre)) = LOWER($1) LIMIT 1`,
      [cleanName],
    );
    if (dupRows[0]) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_DUPLICATE');
    }

    const { rows } = await client.query(
      `INSERT INTO oficinas (nombre)
       VALUES ($1)
       RETURNING id`,
      [cleanName],
    );
    const createdId = rows[0].id;

    if (Array.isArray(usuarioIds)) {
      await setOfficeUsers(createdId, usuarioIds, client);
    }

    const office = await findOfficeById(createdId, client);
    await client.query('COMMIT');
    return { office };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      throw appError('OFFICE_DUPLICATE');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function updateOffice(oficinaId, { nombre, usuarioIds }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existing = await findOfficeById(oficinaId, client);
    if (!existing) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_NOT_FOUND');
    }

    if (nombre !== undefined) {
      const cleanName = String(nombre || '').trim();
      if (!cleanName || cleanName.length > 120) {
        await client.query('ROLLBACK');
        throw appError('OFFICE_INVALID_NAME');
      }

      const { rows: dupRows } = await client.query(
        `SELECT id FROM oficinas WHERE LOWER(TRIM(nombre)) = LOWER($1) AND id <> $2 LIMIT 1`,
        [cleanName, oficinaId],
      );
      if (dupRows[0]) {
        await client.query('ROLLBACK');
        throw appError('OFFICE_DUPLICATE_OTHER');
      }

      await client.query(
        `UPDATE oficinas
         SET nombre = $1, updated_at = NOW()
         WHERE id = $2`,
        [cleanName, oficinaId],
      );
    }

    if (Array.isArray(usuarioIds)) {
      await setOfficeUsers(oficinaId, usuarioIds, client);
    }

    const updated = await findOfficeById(oficinaId, client);
    await client.query('COMMIT');
    return { office: updated };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      throw appError('OFFICE_DUPLICATE_OTHER');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteOffice(oficinaId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT id FROM oficinas WHERE id = $1`,
      [oficinaId],
    );
    if (!existing[0]) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_NOT_FOUND');
    }

    await client.query(
      `UPDATE usuarios SET oficina_id = NULL, updated_at = NOW() WHERE oficina_id = $1`,
      [oficinaId],
    );
    await client.query(
      `DELETE FROM dias_festivos
       WHERE calendario_id IN (
         SELECT id FROM calendarios_oficina WHERE oficina_id = $1
       )`,
      [oficinaId],
    );
    await client.query(`DELETE FROM calendarios_oficina WHERE oficina_id = $1`, [oficinaId]);
    await client.query(`DELETE FROM oficinas WHERE id = $1`, [oficinaId]);
    await client.query('COMMIT');
    return { deleted: true, id: Number(oficinaId) };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function ensureOfficeCalendar(oficinaId, anio, client = pool) {
  const yearNum = Number(anio);
  if (!Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 2200) {
    return null;
  }

  const { rows: existingRows } = await client.query(
    `SELECT id, oficina_id, anio
     FROM calendarios_oficina
     WHERE oficina_id = $1 AND anio = $2
     LIMIT 1`,
    [oficinaId, yearNum],
  );
  if (existingRows[0]) {
    return existingRows[0];
  }

  const { rows } = await client.query(
    `INSERT INTO calendarios_oficina (oficina_id, anio)
     VALUES ($1, $2)
     RETURNING id, oficina_id, anio`,
    [oficinaId, yearNum],
  );
  return rows[0];
}

export async function createOfficeCalendar(oficinaId, anio) {
  const yearNum = Number(anio);
  if (!Number.isInteger(yearNum) || yearNum < 1900 || yearNum > 2200) {
    throw appError('OFFICE_CALENDAR_INVALID_YEAR');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: officeRows } = await client.query(
      `SELECT id FROM oficinas WHERE id = $1`,
      [oficinaId],
    );
    if (!officeRows[0]) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_NOT_FOUND');
    }

    await ensureOfficeCalendar(oficinaId, yearNum, client);
    const office = await findOfficeById(oficinaId, client);
    await client.query('COMMIT');
    return { office };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteOfficeCalendar(oficinaId, calendarioId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existing } = await client.query(
      `SELECT id
       FROM calendarios_oficina
       WHERE id = $1 AND oficina_id = $2`,
      [calendarioId, oficinaId],
    );
    if (!existing[0]) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_CALENDAR_NOT_FOUND');
    }

    await client.query(`DELETE FROM dias_festivos WHERE calendario_id = $1`, [calendarioId]);
    await client.query(
      `DELETE FROM calendarios_oficina WHERE id = $1 AND oficina_id = $2`,
      [calendarioId, oficinaId],
    );
    const office = await findOfficeById(oficinaId, client);
    await client.query('COMMIT');
    return { deleted: true, office };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function addOfficeHoliday(oficinaId, { fecha, nombre, anio }) {
  const cleanDate = String(fecha || '').trim();
  const cleanName = String(nombre || '').trim();
  if (!isValidDateKey(cleanDate) || !cleanName || cleanName.length > 120) {
    throw appError('OFFICE_HOLIDAY_INVALID');
  }

  const yearFromDate = Number(cleanDate.slice(0, 4));
  if (anio !== undefined && anio !== null && anio !== '' && Number(anio) !== yearFromDate) {
    throw appError('OFFICE_HOLIDAY_YEAR_MISMATCH');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: officeRows } = await client.query(
      `SELECT id FROM oficinas WHERE id = $1`,
      [oficinaId],
    );
    if (!officeRows[0]) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_NOT_FOUND');
    }

    const calendar = await ensureOfficeCalendar(oficinaId, yearFromDate, client);
    const { rows: dupRows } = await client.query(
      `SELECT id
       FROM dias_festivos
       WHERE calendario_id = $1 AND fecha = $2
       LIMIT 1`,
      [calendar.id, cleanDate],
    );
    if (dupRows[0]) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_HOLIDAY_DUPLICATE');
    }

    await client.query(
      `INSERT INTO dias_festivos (calendario_id, fecha, nombre)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [calendar.id, cleanDate, cleanName],
    );

    const office = await findOfficeById(oficinaId, client);
    await client.query('COMMIT');
    return { office };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error.code === '23505') {
      throw appError('OFFICE_HOLIDAY_DUPLICATE');
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteOfficeHoliday(oficinaId, festivoId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `DELETE FROM dias_festivos df
       USING calendarios_oficina co
       WHERE df.id = $1
         AND df.calendario_id = co.id
         AND co.oficina_id = $2
       RETURNING df.id`,
      [festivoId, oficinaId],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      throw appError('OFFICE_HOLIDAY_NOT_FOUND');
    }

    const office = await findOfficeById(oficinaId, client);
    await client.query('COMMIT');
    return { deleted: true, id: Number(festivoId), office };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

export async function listHolidaysForUser(userId, client = pool) {
  const { rows } = await client.query(
    `SELECT df.id,
            df.calendario_id AS "calendarioId",
            co.oficina_id AS "oficinaId",
            o.nombre AS "oficinaNombre",
            co.anio,
            TO_CHAR(df.fecha, 'YYYY-MM-DD') AS fecha,
            df.nombre
     FROM usuarios u
     INNER JOIN oficinas o ON o.id = u.oficina_id
     INNER JOIN calendarios_oficina co ON co.oficina_id = o.id
     INNER JOIN dias_festivos df ON df.calendario_id = co.id
     WHERE u.id = $1
     ORDER BY df.fecha ASC, df.id ASC`,
    [userId],
  );
  return rows.map((row) => mapHolidayItem(row)).filter(Boolean);
}

export async function listAllHolidays(
  { oficinaId = null, equipoId = null, anio = null, mes = null } = {},
  client = pool,
) {
  const officeFilter =
    Number.isInteger(Number(oficinaId)) && Number(oficinaId) >= 1 ? Number(oficinaId) : null;
  const teamFilter =
    Number.isInteger(Number(equipoId)) && Number(equipoId) >= 1 ? Number(equipoId) : null;
  const yearFilter =
    Number.isInteger(Number(anio)) && Number(anio) > 1900 ? Number(anio) : null;
  const monthFilter =
    Number.isInteger(Number(mes)) && Number(mes) >= 1 && Number(mes) <= 12 ? Number(mes) : null;

  const conditions = [];
  const params = [];

  if (officeFilter !== null) {
    params.push(officeFilter);
    conditions.push(`co.oficina_id = $${params.length}::bigint`);
  } else if (teamFilter !== null) {
    params.push(teamFilter);
    conditions.push(
      `EXISTS (
        SELECT 1
        FROM usuarios u
        INNER JOIN usuarios_equipos ue ON ue.usuario_id = u.id
        WHERE u.oficina_id = co.oficina_id
          AND ue.equipo_id = $${params.length}::bigint
      )`,
    );
  }

  if (yearFilter !== null && monthFilter !== null) {
    params.push(yearFilter, monthFilter);
    const yIdx = params.length - 1;
    const mIdx = params.length;
    conditions.push(
      `df.fecha >= make_date($${yIdx}::int, $${mIdx}::int, 1) AND df.fecha < (make_date($${yIdx}::int, $${mIdx}::int, 1) + INTERVAL '1 month')`,
    );
  } else if (yearFilter !== null) {
    params.push(yearFilter);
    conditions.push(`co.anio = $${params.length}::int`);
  } else if (monthFilter !== null) {
    params.push(monthFilter);
    conditions.push(`EXTRACT(MONTH FROM df.fecha) = $${params.length}::int`);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  const { rows } = await client.query(
    `SELECT df.id,
            df.calendario_id AS "calendarioId",
            co.oficina_id AS "oficinaId",
            o.nombre AS "oficinaNombre",
            co.anio,
            TO_CHAR(df.fecha, 'YYYY-MM-DD') AS fecha,
            df.nombre
     FROM dias_festivos df
     INNER JOIN calendarios_oficina co ON co.id = df.calendario_id
     INNER JOIN oficinas o ON o.id = co.oficina_id
     ${whereClause}
     ORDER BY df.fecha ASC, o.nombre ASC, df.id ASC`,
    params,
  );
  return rows.map((row) => mapHolidayItem(row)).filter(Boolean);
}

export async function findUserHolidayConflicts(userId, dateStrings, client = pool) {
  if (!Array.isArray(dateStrings) || dateStrings.length === 0) {
    return [];
  }
  const { rows } = await client.query(
    `SELECT df.id,
            df.calendario_id AS "calendarioId",
            co.oficina_id AS "oficinaId",
            o.nombre AS "oficinaNombre",
            co.anio,
            TO_CHAR(df.fecha, 'YYYY-MM-DD') AS fecha,
            df.nombre
     FROM usuarios u
     INNER JOIN oficinas o ON o.id = u.oficina_id
     INNER JOIN calendarios_oficina co ON co.oficina_id = o.id
     INNER JOIN dias_festivos df ON df.calendario_id = co.id
     WHERE u.id = $1
       AND TO_CHAR(df.fecha, 'YYYY-MM-DD') = ANY($2::text[])
     ORDER BY df.fecha ASC, df.id ASC`,
    [userId, dateStrings],
  );
  return rows.map((row) => mapHolidayItem(row)).filter(Boolean);
}
