# Evidence: scaffold (Wave 0, architect)

## What was set up
- One root `package.json`; `npm ci` installs everything listed in `docs/worker-briefs.md`. `.npmrc` sets `legacy-peer-deps=true` because npm 10 crashes (`Cannot read properties of null (reading 'edgesOut')`) resolving Vitest's optional peers.
- `@cloudflare/vitest-pool-workers` is deprecated and renamed, so the scaffold uses `@cloudflare/vitest-plugin` with Vitest 4.
- TypeScript 5.9 (TypeScript 7's native compiler was skipped to keep `checkJs` behavior predictable).
- Configs: root `vitest.config.ts` (shared, cli), `server/vitest.config.ts` (Workers runtime), `dashboard/vitest.config.ts` (happy-dom), `test/vitest.config.ts` (e2e, smoke).
- Placeholders: `server/src/{worker,room,env}.ts`, `dashboard/{build.mjs,src/}`, `cli/hivemind.mjs`.
- `shared/`: `contracts.ts` (wire types, limits and internal interfaces), `hook-modules.d.ts`, `state.ts` with tests, `protocol.md`, `fixtures/snapshot.json`.
- CI: Ubuntu (typecheck, all tests, build, `wrangler deploy --dry-run`, e2e), Windows (Node tests: shared and cli), gitleaks with an `hm_` token rule and a `hm_[av].test.` allowlist.

## Checks run locally
- `npm run typecheck`: pass.
- `npm test`: shared state tests (6) and the Workers `/health` test (1) pass.
- `npm run build`, then `npx wrangler deploy --dry-run -c server/wrangler.toml`: pass.

## §21 items 13 and 14
- **13 (Cloudflare limits):** from the Durable Objects pricing and limits pages: 100,000 Durable Object requests a day, 13,000 GB-s a day, 5 million rows read and 100,000 rows written a day, reset at 00:00 UTC; Workers Free allows 100,000 requests a day with 10 ms CPU each. Static asset requests don't invoke the Worker. Still to measure after the first deploy: how index writes and deletes count.
- **14:** the CLI and hook are plain ESM JavaScript with a root `bin`, so `npx github:` needs no build step. The Workers test pool isn't run on Windows CI (fallback taken: Room tests are Ubuntu-only); Windows CI runs the shared and cli tests.
