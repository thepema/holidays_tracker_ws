import Fastify from 'fastify';
import cors from '@fastify/cors';
import pool from './db.js';

const app = Fastify({
  logger: true,
});

const isTrustedOrigin = (origin) => {
  if (!origin) return false;

  try {
    const { protocol, hostname } = new URL(origin);
    const isMaisonZaroDomain = hostname === 'maisonzaro.com' || hostname.endsWith('.maisonzaro.com');
    return protocol === 'https:' && isMaisonZaroDomain;
  } catch {
    return false;
  }
};

const localOrigins = new Set([
  'http://localhost:4200',
  'http://127.0.0.1:4200',
]);

await app.register(cors, {
  origin: (origin, callback) => callback(null, isTrustedOrigin(origin) || localOrigins.has(origin)),
});

app.get('/', async () => ({
  message: '¡Hola, mundo!',
}));

app.get('/api/vacaciones', async (_request, reply) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        v.id,
        v.usuario_id AS "usuarioId",
        v.anio,
        v.fecha,
        u.nombre,
        u.apellidos,
        u.cargo
      FROM vacaciones AS v
      INNER JOIN usuarios AS u ON u.id = v.usuario_id
      ORDER BY v.fecha ASC, v.id ASC
    `);

    return { vacaciones: rows };
  } catch (error) {
    request.log.error({ err: error }, 'No se pudieron consultar las vacaciones');
    return reply.code(503).send({ error: 'No se pudieron consultar las vacaciones.' });
  }
});

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ host: '0.0.0.0', port });
  } catch (error) {
    app.log.error(error);
    await pool.end();
    process.exit(1);
  }
};

await start();
