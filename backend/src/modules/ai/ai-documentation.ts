import { Router } from 'express';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** Local assets only. This router is mounted before authentication; it serves no business data. */
export function aiDocumentation() {
  const router = Router();
  const assets = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
  router.get('/api/v1/ai/docs', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>AI triage API</title><link rel="stylesheet" href="/api/v1/ai/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/api/v1/ai/docs/swagger-ui-bundle.js"></script><script src="/api/v1/ai/docs/init.js"></script></body></html>`));
  for (const filename of ['swagger-ui.css', 'swagger-ui-bundle.js']) router.get(`/api/v1/ai/docs/${filename}`, (_req, res) => res.sendFile(join(assets, filename)));
  router.get('/api/v1/ai/docs/init.js', (_req, res) => res.type('application/javascript').send("SwaggerUIBundle({url:'/api/v1/ai/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false});"));
  router.get('/api/v1/ai/openapi.json', async (_req, res, next) => {
    try {
      let contents: string;
      try { contents = await readFile(new URL('../../../../docs/api/ai-openapi.json', import.meta.url), 'utf8'); }
      catch { contents = await readFile(join(process.cwd(), '..', 'docs', 'api', 'ai-openapi.json'), 'utf8'); }
      const spec = JSON.parse(contents);
      res.json(spec);
    } catch (error) { next(error); }
  });
  return router;
}
