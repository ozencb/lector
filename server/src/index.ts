import { join, resolve } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import cors from '@fastify/cors';
import { initDb } from './db.js';
import { booksRoutes } from './routes/books.js';
import { chaptersRoutes } from './routes/chapters.js';
import { ttsRoutes } from './routes/tts.js';

const server = Fastify({ logger: true });

const isProduction = process.env.NODE_ENV === 'production';

// CORS in development (client on port 5173)
if (!isProduction) {
  server.register(cors, { origin: 'http://localhost:5173' });
}

server.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

// Serve cover images from data/covers/
const coversDir = resolve('data', 'covers');
mkdirSync(coversDir, { recursive: true });
server.register(fastifyStatic, {
  root: coversDir,
  prefix: '/api/covers/',
  decorateReply: false,
});

// In production, serve built client SPA
if (isProduction) {
  const clientDist = resolve('..', 'client', 'dist');
  server.register(fastifyStatic, {
    root: clientDist,
    prefix: '/',
    decorateReply: true,
    wildcard: false,
  });

  // SPA fallback: non-API routes serve index.html
  server.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith('/api/')) {
      return reply.status(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
}

server.get('/health', async () => {
  return { status: 'ok' };
});

server.register(booksRoutes);
server.register(chaptersRoutes);
server.register(ttsRoutes);

const start = async () => {
  try {
    initDb();
    server.log.info('Database initialized');
    await server.listen({ port: 3000, host: '0.0.0.0' });
    console.log('Server started on port 3000');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
