import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env';

/** Placeholder from the Wave 0 scaffold. W1 (server-core) replaces it. */
export class Room extends DurableObject<Env> {
  override async fetch(_request: Request): Promise<Response> {
    return new Response('not implemented', { status: 501 });
  }
}
