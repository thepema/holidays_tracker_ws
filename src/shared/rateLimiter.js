const buckets = new Map();
const cooldowns = new Map();

const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRY_AGE_MS = 24 * 60 * 60 * 1000;

function cleanupExpiredEntries() {
  const now = Date.now();

  for (const [bucketName, store] of buckets.entries()) {
    for (const [key, entry] of store.entries()) {
      const latestTimestamp = entry.timestamps.length
        ? entry.timestamps[entry.timestamps.length - 1]
        : 0;
      const isBlockExpired = entry.blockedUntil <= now;
      const isStale = now - Math.max(latestTimestamp, entry.blockedUntil) > DEFAULT_MAX_ENTRY_AGE_MS;

      if (isBlockExpired && (entry.timestamps.length === 0 || isStale)) {
        store.delete(key);
      }
    }
    if (store.size === 0) {
      buckets.delete(bucketName);
    }
  }

  for (const [bucketName, store] of cooldowns.entries()) {
    for (const [key, expiresAt] of store.entries()) {
      if (expiresAt <= now) {
        store.delete(key);
      }
    }
    if (store.size === 0) {
      cooldowns.delete(bucketName);
    }
  }
}

const cleanupTimer = setInterval(cleanupExpiredEntries, CLEANUP_INTERVAL_MS);
if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

function getStore(container, bucket) {
  let store = container.get(bucket);
  if (!store) {
    store = new Map();
    container.set(bucket, store);
  }
  return store;
}

/**
 * Extrae la IP real del cliente priorizando cabeceras de proxy inverso.
 */
export function getClientIp(request) {
  const forwardedFor = request?.headers?.['x-forwarded-for'];
  if (typeof forwardedFor === 'string' && forwardedFor.trim()) {
    const firstIp = forwardedFor.split(',')[0].trim();
    if (firstIp) return firstIp;
  }

  const realIp = request?.headers?.['x-real-ip'];
  if (typeof realIp === 'string' && realIp.trim()) {
    return realIp.trim();
  }

  return String(request?.ip || request?.socket?.remoteAddress || 'unknown').trim() || 'unknown';
}

/**
 * Evalúa y registra una petición sobre una ventana deslizante con bloqueo temporal opcional.
 */
export function checkRateLimit({
  bucket,
  key,
  maxRequests,
  windowMs,
  blockDurationMs = windowMs,
  now = Date.now(),
}) {
  const store = getStore(buckets, String(bucket));
  const normalizedKey = String(key || 'global');
  let entry = store.get(normalizedKey);

  if (!entry) {
    entry = { timestamps: [], blockedUntil: 0 };
    store.set(normalizedKey, entry);
  }

  if (entry.blockedUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((entry.blockedUntil - now) / 1000));
    return {
      allowed: false,
      retryAfterSeconds,
      remaining: 0,
    };
  }

  const cutoff = now - windowMs;
  entry.timestamps = entry.timestamps.filter((ts) => ts > cutoff);

  if (entry.timestamps.length >= maxRequests) {
    const duration = Math.max(1000, Number(blockDurationMs) || windowMs);
    entry.blockedUntil = now + duration;
    const retryAfterSeconds = Math.max(1, Math.ceil(duration / 1000));
    return {
      allowed: false,
      retryAfterSeconds,
      remaining: 0,
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, maxRequests - entry.timestamps.length),
  };
}

/**
 * Comprueba si una clave sigue dentro de un periodo de enfriamiento sin modificarla.
 */
export function checkCooldown({ bucket, key, now = Date.now() }) {
  const store = cooldowns.get(String(bucket));
  if (!store) {
    return { allowed: true, retryAfterSeconds: 0 };
  }

  const normalizedKey = String(key || 'global');
  const expiresAt = store.get(normalizedKey) || 0;
  if (expiresAt > now) {
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((expiresAt - now) / 1000)),
    };
  }

  store.delete(normalizedKey);
  return { allowed: true, retryAfterSeconds: 0 };
}

/**
 * Registra un cooldown activo para la clave indicada.
 */
export function markCooldown({ bucket, key, cooldownMs, now = Date.now() }) {
  const store = getStore(cooldowns, String(bucket));
  const normalizedKey = String(key || 'global');
  const expiresAt = now + Math.max(0, Number(cooldownMs) || 0);
  store.set(normalizedKey, expiresAt);
  return expiresAt;
}

/**
 * Crea un preHandler de Fastify que limita peticiones y responde HTTP 429 con Retry-After.
 */
export function createRateLimitPreHandler({
  bucket,
  maxRequests,
  windowMs,
  blockDurationMs = windowMs,
  keyGenerator = getClientIp,
  errorMessage = 'Demasiadas peticiones. Espera unos instantes antes de volver a intentarlo.',
}) {
  return async function rateLimitPreHandler(request, reply) {
    const key = keyGenerator(request);
    const result = checkRateLimit({
      bucket,
      key,
      maxRequests,
      windowMs,
      blockDurationMs,
    });

    if (!result.allowed) {
      reply.header('Retry-After', String(result.retryAfterSeconds));
      return reply.code(429).send({
        error: `${errorMessage} Podrás intentarlo de nuevo en ${result.retryAfterSeconds}s.`,
        retryAfterSeconds: result.retryAfterSeconds,
      });
    }
  };
}

/**
 * Reinicia el estado en memoria (útil para pruebas automatizadas).
 */
export function resetRateLimiterState() {
  buckets.clear();
  cooldowns.clear();
}
