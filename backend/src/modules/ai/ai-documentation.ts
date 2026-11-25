import { Router, type NextFunction, type Response } from 'express';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { readFile } from 'node:fs/promises';

/** Local assets only. This router is mounted before authentication; it serves no business data. */
export function aiDocumentation() {
  const router = Router();
  const assets = dirname(createRequire(import.meta.url).resolve('swagger-ui-dist/package.json'));
  router.get('/api/v1/ai/docs', (_req, res) => res.type('html').send(`<!doctype html><html><head><meta charset="utf-8"><title>AI triage API</title><link rel="stylesheet" href="/api/v1/ai/docs/swagger-ui.css"></head><body><div id="swagger-ui"></div><script src="/api/v1/ai/docs/swagger-ui-bundle.js"></script><script src="/api/v1/ai/docs/init.js"></script></body></html>`));
  for (const filename of ['swagger-ui.css', 'swagger-ui-bundle.js']) router.get(`/api/v1/ai/docs/${filename}`, (_req, res) => res.sendFile(join(assets, filename)));
  router.get('/api/v1/ai/docs/init.js', (_req, res) => res.type('application/javascript').send("SwaggerUIBundle({url:'/api/v1/openapi.json',dom_id:'#swagger-ui',persistAuthorization:false});"));

  async function serveOpenApi(filename: string, response: Response, next: NextFunction) {
    try {
      let contents: string;
      try { contents = await readFile(new URL(`../../../../docs/api/${filename}`, import.meta.url), 'utf8'); }
      catch {
        try { contents = await readFile(join(process.cwd(), 'docs', 'api', filename), 'utf8'); }
        catch { contents = await readFile(join(process.cwd(), '..', 'docs', 'api', filename), 'utf8'); }
      }
      response.json(JSON.parse(contents));
    } catch (error) { next(error); }
  }

  router.get('/api/v1/openapi.json', (_request, response, next) => serveOpenApi('integrated-openapi.json', response, next));
  router.get('/api/v1/ai/openapi.json', (_request, response, next) => serveOpenApi('ai-openapi.json', response, next));
  return router;
}
