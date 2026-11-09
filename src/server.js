import Fastify from 'fastify';
import cors from '@fastify/cors';

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

await app.register(cors, {
  // Allow the API's own origin and sibling app subdomains, but not unrelated sites.
  origin: (origin, callback) => callback(null, isTrustedOrigin(origin)),
});

app.get('/', async () => ({
  message: '¡Hola, mundo!',
}));

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
