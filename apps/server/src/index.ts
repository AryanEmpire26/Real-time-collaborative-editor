import { randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { documentIdPattern, maxTitleLength } from '@mergepad/shared';
import pino from 'pino';
import { Collaboration } from './collaboration.js';
import { Store } from './store.js';

const port = Number(process.env.PORT ?? 4000);
const origin = new URL(process.env.PUBLIC_ORIGIN ?? 'http://localhost:3000').origin;
const instance = process.env.INSTANCE_ID ?? randomUUID();
const log = pino({ name: 'mergepad', level: process.env.LOG_LEVEL ?? 'info', base: { instance } });
const store = new Store(process.env.DATABASE_URL ?? 'postgres://mergepad:mergepad@localhost:5432/mergepad');
const collab = new Collaboration(process.env.REDIS_URL ?? 'redis://localhost:6379', instance, store, log);
store.pool.on('error', (err) => log.error({ err }, 'Idle PostgreSQL connection failed'));

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function titleFrom(req: IncomingMessage) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') return;
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > 4096) {
      req.resume();
      return;
    }
    chunks.push(chunk);
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (value && typeof value === 'object' && 'title' in value && typeof value.title === 'string') {
      const title = value.title.trim();
      if (title.length && title.length <= maxTitleLength && [...title].every((char) => char.charCodeAt(0) >= 32)) return title;
    }
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const pathname = req.url?.split('?')[0];
  if (req.method === 'GET' && pathname === '/healthz') {
    try {
      if (!collab.ready) throw new Error('Redis unavailable');
      await store.pool.query('SELECT 1');
      return json(res, 200, { status: 'ready', instance });
    } catch (err) {
      log.warn({ err }, 'Readiness check failed');
      return json(res, 503, { status: 'unavailable', instance });
    }
  }
  if (req.method === 'GET' && pathname === '/metrics') {
    res.setHeader('Content-Type', collab.metrics.contentType);
    return res.end(await collab.metrics.metrics());
  }
  if (req.method === 'GET' && pathname === '/api/documents') return json(res, 200, await store.list());
  if (req.method === 'POST' && pathname === '/api/documents') {
    if (req.headers.origin && req.headers.origin !== origin) return json(res, 403, { error: 'Origin not allowed' });
    const title = await titleFrom(req);
    if (!title) return json(res, 400, { error: `Use a title containing 1 to ${maxTitleLength} characters.` });
    return json(res, 201, await store.create(title));
  }
  const id = pathname?.match(/^\/api\/documents\/([^/]+)$/)?.[1];
  if (req.method === 'GET' && id && documentIdPattern.test(id)) {
    const doc = await store.get(id);
    if (doc) return json(res, 200, { id: doc.id, title: doc.title, updatedAt: doc.updatedAt });
  }
  json(res, 404, { error: 'Not found' });
}

const server = createServer({ requestTimeout: 10_000 }, (req, res) => {
  void handle(req, res).catch((err) => {
    log.error({ err, method: req.method }, 'Request failed');
    if (res.headersSent) res.destroy();
    else json(res, 503, { error: 'Service temporarily unavailable' });
  });
});
server.on('upgrade', (req, sock, head) => collab.upgrade(req, sock, head, origin));
server.on('error', (err) => {
  log.fatal({ err }, 'HTTP server failed');
  process.exit(1);
});

try {
  await store.initialize();
  await collab.start();
  server.listen(port, '0.0.0.0', () => log.info({ port }, 'Listening'));
} catch (err) {
  log.fatal({ err }, 'Startup failed');
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    log.info({ signal }, 'Shutting down');
    const deadline = setTimeout(() => process.exit(1), 9000).unref();
    const httpClosed = new Promise<void>((resolve) => server.close(() => resolve()));
    void Promise.all([collab.stop(), httpClosed]).then(() => store.pool.end()).then(() => {
      clearTimeout(deadline);
    }).catch((err) => {
      log.error({ err }, 'Shutdown failed');
      process.exit(1);
    });
  });
}
