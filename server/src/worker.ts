import type { Env } from './env';
export { Room } from './room';

/** Placeholder from the Wave 0 scaffold. W1 (server-core) replaces it. */
export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true });
    return Response.json({ error: 'not implemented' }, { status: 501 });
  },
} satisfies ExportedHandler<Env>;
