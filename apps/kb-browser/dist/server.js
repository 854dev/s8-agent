import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createLibrary } from './library.js';
const ALLOWED_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.pdf', '.docx', '.xlsx', '.txt', '.md', '.html', '.csv', '.json', '.zip', '.mp4', '.mp3', '.ogg']);
export function buildServer(root = process.env.KB_ROOT ?? '/workspace') {
    const app = Fastify({ logger: true, bodyLimit: 210 * 1024 * 1024 });
    app.register(multipart, { limits: { fileSize: 200 * 1024 * 1024 } });
    const library = createLibrary(root);
    app.get('/health', async () => ({ status: 'ok', service: '854md-kb-browser' }));
    app.get('/api/docs/tree', async (request, reply) => {
        const query = request.query;
        try {
            const rows = await library.entries(query.path ?? '', Number(query.depth ?? 2));
            return { root: query.path ?? '', entries: rows };
        }
        catch {
            return reply.code(400).send({ error: 'invalid path or depth' });
        }
    });
    app.get('/api/docs/file', async (request, reply) => {
        const query = request.query;
        if (!query.path)
            return reply.code(400).send({ error: 'path is required' });
        try {
            return await library.readFile(query.path);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '';
            return reply.code(message === 'file unavailable' ? 404 : 403).send({ error: 'file is unavailable' });
        }
    });
    app.get('/api/docs/search', async (request, reply) => {
        const query = request.query;
        if (!query.q?.trim())
            return reply.code(400).send({ error: 'q is required' });
        try {
            return { query: query.q, results: await library.search(query.q, Number(query.limit ?? 50)) };
        }
        catch {
            return reply.code(400).send({ error: 'invalid search request' });
        }
    });
    app.get('/api/docs/recent', async (request) => {
        const query = request.query;
        return { results: await library.recent(Number(query.limit ?? 20)) };
    });
    app.post('/api/files/upload', async (request, reply) => {
        const uploadDir = process.env.UPLOAD_DIR ?? path.join(library.root, 'uploads');
        await fs.mkdir(uploadDir, { recursive: true });
        const data = await request.file();
        if (!data)
            return reply.code(400).send({ error: 'no file part' });
        const originalName = data.filename;
        const ext = path.extname(originalName).toLowerCase();
        if (!ALLOWED_EXT.has(ext)) {
            return reply.code(400).send({ error: `extension \`${ext}\` not allowed` });
        }
        const id = randomUUID().slice(0, 8);
        const safeName = `${id}-${originalName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
        const dest = path.join(uploadDir, safeName);
        const stream = createWriteStream(dest);
        await data.file.pipe(stream);
        await new Promise((resolve, reject) => {
            stream.on('finish', resolve);
            stream.on('error', reject);
        });
        return { id, originalName, savedAs: safeName, size: (await fs.stat(dest)).size };
    });
    app.get('/', async () => ({ service: '854md-kb-browser', root: path.basename(library.root) }));
    return app;
}
if (import.meta.url === `file://${process.argv[1]}`) {
    const app = buildServer();
    const port = Number(process.env.PORT ?? 8787);
    const host = process.env.HOST ?? '0.0.0.0';
    app.listen({ port, host }).catch((error) => {
        app.log.error(error);
        process.exit(1);
    });
}
