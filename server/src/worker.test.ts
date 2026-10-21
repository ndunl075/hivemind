import { SELF } from 'cloudflare:test';
import { expect, it } from 'vitest';

it('answers /health', async () => {
  const res = await SELF.fetch('https://example.com/health');
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});
