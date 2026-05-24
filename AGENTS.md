# Creator Repository Notes

## Structure

- This is one Vite application, not a workspace: `src/` is the React SPA and `worker/index.ts` is the Hono Cloudflare Worker entrypoint.
- The Cloudflare Vite plugin runs both halves locally. `wrangler.jsonc` routes `/api/*` through the Worker first and serves other paths as SPA assets/fallbacks.
- API/database records are snake_case in the Worker; `src/lib/api.ts` is the explicit camelCase adapter used by the UI. Keep both sides aligned when response fields change.
- Persistent state is D1 schema in `migrations/`; private image bytes live in R2 through `MEDIA` and are served/transformed only through Worker routes using `IMAGES`.

## Commands

- Project documentation and scripts use npm even though `bun.lock` is present: use `npm install` and `npm run ...` unless specifically changing package-manager policy.
- Initialize or update local D1 state before exercising database-backed UI/API work: `npm run db:migrate:local`.
- Local full-stack development: `npm run dev`.
- Validation commands: `npm run lint`, `npm run typecheck`, and `npm run build`; `build` already runs `tsc -b` before the Vite/Worker production build.
- There is currently no automated test script or focused-test runner in `package.json`; do not assume `npm test` exists.
- `npm run format` only formats `*.ts` and `*.tsx`; its Tailwind Prettier plugin uses `src/index.css` and sorts classes in `cn`/`cva` calls.

## Runtime And Deployment Constraints

- Paid API behavior requires `REPLICATE_API_TOKEN` and `OPENCODE_ZEN_API_KEY`; webhook verification uses `REPLICATE_WEBHOOK_SIGNING_SECRET`. Local values may be supplied via `.env` or `.dev.vars` as shown in `.dev.vars.example`.
- Replicate completion webhooks are registered only when `PUBLIC_APP_URL` begins with `https://`; local completion instead depends on the generation SSE endpoint while a browser remains connected.
- `wrangler.jsonc` contains a placeholder D1 `database_id`. Before remote migration or deploy, configure the actual D1 database, R2 bucket, remote secrets, and deployed `PUBLIC_APP_URL`.
- Production Access must leave only `/api/webhooks/replicate` publicly reachable for Replicate; the Worker performs mandatory signature validation on that route.

## Data Invariants

- The Worker permits only one non-terminal generation per conversation; changes to generation flows must preserve the busy-conversation check and terminal/SSE reconciliation behavior.
- Conversation deletion and Person deletion are soft deletes. Forks preserve historical lineage through `conversation_turn_links` and reuse existing assets rather than copying media.
- Gallery output deletion is rejected while an active conversation still references the output; generated PNG masters and dynamically transformed WebP previews have different storage/serving behavior.
