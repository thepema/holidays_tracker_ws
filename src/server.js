import Fastify from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import adminRoutes from './routes/admin.js';
import authRoutes from './routes/auth.js';
import vacationRoutes from './routes/vacations.js';
import { authenticateSession } from './services/sessionService.js';

const app = Fastify({ logger: true });
const SESSION_COOKIE_NAME = 'ht_session';

const isTrustedOrigin = (origin) => {
  if (!origin) return true;
  try {
    const { protocol, hostname } = new URL(origin);
    return protocol === 'https:' &&
      (hostname === 'maisonzaro.com' || hostname.endsWith('.maisonzaro.com'));
  } catch {
    return false;
  }
};

const localOrigins = new Set([
  'http://localhost:4200',
  'http://127.0.0.1:4200',
  ...(process.env.FRONTEND_ORIGIN ? [process.env.FRONTEND_ORIGIN] : []),
]);

await app.register(cors, {
  origin: (origin, callback) => callback(null, isTrustedOrigin(origin) || localOrigins.has(origin)),
  credentials: true,
});
await app.register(cookie);

// Register Swagger before API routes so Fastify can collect their schemas.
await app.register(swagger, {
  openapi: {
    openapi: '3.0.3',
    info: {
      title: 'Holiday Tracker API',
      description: 'API para administrar usuarios, sesiones y vacaciones.',
      version: '1.0.0',
    },
    servers: [{ url: '/', description: 'Servidor actual' }],
    components: {
      securitySchemes: {
        AdminBearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token Bearer obtenido en POST /api/admin/login.',
        },
        SessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: SESSION_COOKIE_NAME,
          description: 'Cookie establecida al activar o recuperar una sesión de usuario.',
        },
      },
    },
  },
});

await app.register(swaggerUi, {
  routePrefix: '/docs',
  uiConfig: {
    docExpansion: 'list',
    deepLinking: true,
    persistAuthorization: true,
    withCredentials: true,
  },
});

app.decorateRequest('user', null);
app.decorateRequest('isAdmin', false);

app.get('/', async () => ({ message: 'Holiday Tracker API' }));

app.addHook('preHandler', async (request) => {
  const token = request.cookies?.[SESSION_COOKIE_NAME];
  if (token) request.user = await authenticateSession(token);
});

await app.register(adminRoutes, { prefix: '/api' });
await app.register(authRoutes, { prefix: '/api' });
await app.register(vacationRoutes, { prefix: '/api' });

app.setErrorHandler((error, request, reply) => {
  request.log.error({ err: error }, 'Error no controlado en la API');
  return reply.code(500).send({ error: 'Error interno del servidor.' });
});

const start = async () => {
  try {
    const port = Number(process.env.PORT) || 3000;
    await app.listen({ host: '0.0.0.0', port });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
