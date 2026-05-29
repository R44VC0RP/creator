# Creator

Image-generation workspace built with React, Vite, shadcn/ui, and a Cloudflare Worker API.

## Runtime

- Frontend: React/Vite SPA using shadcn/ui.
- API: integrated Cloudflare Worker under `/api/*`, implemented with Hono.
- Metadata: Cloudflare D1, with local SQLite-compatible state through Wrangler.
- Media: private Cloudflare R2 bucket.
- Image normalization and preview variants: Cloudflare Images binding.
- Generation: WaveSpeed `openai/gpt-image-2`, `bytedance/seedance-2.0/text-to-video`, and `kwaivgi/kling-video-o3-pro/image-to-video`; Replicate `xai/grok-imagine-video`.
- Conversation titles: OpenCode Zen `claude-haiku-4-5` through the Anthropic AI SDK provider.
- Video prompt enhancement: OpenCode Zen `gpt-5.5` through the OpenAI AI SDK Responses provider.

## Local Setup

Install dependencies:

```bash
npm install
```

The Worker needs server-side values for paid external APIs. The Cloudflare Vite plugin can load local variables from `.env`; `.dev.vars` is also supported for Wrangler-oriented local configuration. Both are ignored by git.

Required values:

```env
REPLICATE_API_TOKEN=
WAVESPEED_API_KEY=
OPENCODE_ZEN_API_KEY=
REPLICATE_WEBHOOK_SIGNING_SECRET=
PUBLIC_APP_URL=http://localhost:5173
```

`PUBLIC_APP_URL` must be an HTTPS deployed URL before Replicate completion webhooks are registered. Local generation completion is reconciled through the SSE endpoint while the browser is connected.

Apply the local D1 schema:

```bash
npm run db:migrate:local
```

Start development:

```bash
npm run dev
```

## Configuration Before Deploying

`wrangler.jsonc` targets the isolated `creator-generator-app-prod` Worker. Wrangler automatically provisions dedicated D1 and R2 resources for its draft `DB` and `MEDIA` bindings on first deployment.

For first deployment, deploy once to provision the Worker resources, then apply its D1 migrations:

```bash
bun run deploy
npm run db:migrate:remote
```

After that Worker exists, configure its remote server-side secrets:

```bash
bun run secrets:push --dry-run
bun run secrets:push
```

The upload script reads the known application values from local `.env` or process environment, refuses to upload without required provider keys, and explicitly targets `creator-generator-app-prod`. It uploads `REPLICATE_API_TOKEN`, `WAVESPEED_API_KEY`, and `OPENCODE_ZEN_API_KEY`; it also includes `REPLICATE_WEBHOOK_SIGNING_SECRET` when set. No other local environment variables are uploaded.

Set `PUBLIC_APP_URL` separately after choosing the deployed HTTPS URL; do not upload the local `http://localhost:5173` development value:

```bash
npx wrangler secret put PUBLIC_APP_URL --name creator-generator-app-prod
```

For later application deployments, apply new remote migrations before publishing code that uses them:

```bash
npm run db:migrate:remote
bun run deploy
```

The deployed application should be protected by Cloudflare Access before paid generation endpoints are exposed.

The signed Replicate completion webhook route must remain reachable by Replicate in production. Configure a narrowly scoped Access bypass for `/api/webhooks/replicate`, and rely on mandatory Replicate webhook signature verification for that route; do not bypass protection for the other `/api/*` endpoints.

## API

### People

```text
GET    /api/people
POST   /api/people                       multipart: name, handle, image
PATCH  /api/people/:id                   JSON: name?, handle?
DELETE /api/people/:id                   archives a Person
```

Person portraits are validated and normalized into private WebP R2 assets. Archived People are excluded from future prompting but remain available through historical turn input metadata.

### Conversations

```text
GET    /api/conversations
GET    /api/conversations/:id
PATCH  /api/conversations/:id            JSON: title
DELETE /api/conversations/:id            hides the thread; preserves outputs
```

`GET /api/conversations/:id` returns ordered turns and their ordered reference inputs, including fork snapshot markers.

### Generations

```text
POST   /api/generations                   multipart generation/modification request
GET    /api/generations/:id
GET    /api/generations/:id/events        SSE live lifecycle updates
POST   /api/generations/:id/cancel
POST   /api/generations/:id/regenerate    Rerun succeeded, failed or canceled turn; JSON: conversationId? for fork context
POST   /api/turns/:id/revise              Create a new branch with edited prompt text and original inputs/settings
POST   /api/prompts/video/enhance          JSON: prompt, model, duration, generateAudio; returns an enhanced prompt
```

Generation multipart fields:

```text
prompt          required string
mode            image | video; defaults to image
model           openai/gpt-image-2 for images; video models are described below
aspectRatio     1:1 | 3:2 | 2:3 | 16:9
quality         low | medium | high; mapped to 1k | 2k | 4k respectively
personIds       repeatable; maximum four
attachments     repeatable image file; maximum two
conversationId  include for modifications
parentTurnId    include for modifications
```

Initial generations accept at most six image references: four People and two prompt attachments. Modifications also include the immediately previous generated image as the edit base, for at most seven reference images. Only People tagged in the current modification are submitted again.

Image turns use WaveSpeed `openai/gpt-image-2`: prompts with no input images use `openai/gpt-image-2/text-to-image`, while turns with People, uploaded references, or a prior output use `openai/gpt-image-2/edit`. Private GPT reference assets are supplied as inline data URLs rather than uploaded to WaveSpeed media storage. Its single visible quality tier also fixes WaveSpeed output resolution: `low` uses `1k`, `medium` uses `2k`, and `high` uses `4k`. Historical Grok image outputs remain visible, but reruns, revisions, and follow-up edits from them submit as GPT image turns.

Video mode is available from a completed focused still image and creates a derivative video output without replacing the still-image edit branch. Seedance uses WaveSpeed model `bytedance/seedance-2.0/text-to-video`, passing the focused still through `reference_images` for image-guided fidelity, with `videoResolution: 720p | 1080p`. Kling uses WaveSpeed model `kwaivgi/kling-video-o3-pro/image-to-video`, passing the focused still as `image`; it uses source-guided framing, supports `5` or `10` seconds, and exposes its audio toggle. Grok video stays on Replicate as `xai/grok-imagine-video` with `videoResolution: 480p | 720p`. Video outputs are persisted as private MP4 assets in R2 and served directly rather than through image transformations.

The API enforces one active generation per conversation. Successful output PNG masters are imported from the generation provider into private R2 storage immediately after completion.

### Provider Benchmark

Run a paid, sequential generation baseline using local `WAVESPEED_API_KEY` and `REPLICATE_API_TOKEN` values:

```bash
bun run benchmark
```

The benchmark runs three text-only WaveSpeed GPT Image 2 generations. It then creates one WaveSpeed Seedance text-to-video output, guided by each GPT output as a reference image, and one Replicate Grok video from each GPT output. Jobs run one at a time so recorded durations are straightforward to compare.

Benchmark settings are intentionally fixed in `scripts/benchmark.ts`: GPT uses the app's `Medium` tier (`2k`) at `16:9`, and generated videos use `720p`, `16:9`, and a 5-second duration. Results and provider output URLs are written to ignored timestamped JSON and Markdown files under `benchmark-results/`.

The active generation UI uses benchmark averages plus a 30-second completion buffer as an explicitly labeled estimated progress percentage for these model/provider paths. The current Seedance text-to-video estimate is based on the `benchmarks/test-alpha` reference-image comparison, and the Kling O3 Pro estimate is based on the `benchmarks/test-beta` image-to-video comparison. Estimated progress advances by elapsed time, caps at `99%` until a provider reports completion, and changes to `100%` while the output is being persisted. It is not provider-reported generation progress.

### Forks

```text
POST /api/turns/:id/fork
```

Forking a successful output creates a new conversation whose copied lineage is read-only through the fork point. Existing R2 media is reused, not copied. New turns then branch from the forked focused image.

Revising a prompt is also non-destructive: it creates a new conversation branch inheriting visible lineage before the selected turn, then reruns the edited prompt using that turn's original model, settings, and stored input assets. Existing results and Gallery outputs are retained.

### Gallery And Assets

```text
GET    /api/gallery
GET    /api/gallery/:assetId
DELETE /api/gallery/:assetId

GET /api/assets/:assetId/content
GET /api/assets/:assetId/content?variant=thumbnail
GET /api/assets/:assetId/content?variant=preview
GET /api/assets/:assetId/content?download=1
```

Gallery contains every successful generated output. Permanent Gallery deletion is blocked while any active conversation references the image. PNG masters are stored privately; thumbnail and preview responses are dynamically optimized WebP variants.

### External Completion

```text
POST /api/webhooks/replicate?turnId=:turnId
```

Production Replicate generations provide Replicate with a completion webhook URL only when `PUBLIC_APP_URL` is HTTPS. Deliveries are signature-validated, idempotent, and used to persist completed outputs even when no browser SSE connection remains active. WaveSpeed-backed GPT Image 2 and Seedance turns are currently reconciled through the application's SSE polling path because WaveSpeed's public webhook documentation does not specify signature verification; keep the generating browser session connected until those tasks are imported into R2.

## Scripts

```bash
npm run dev                 # SPA and Worker local development
npm run build               # Typecheck and Cloudflare/Vite production build
npm run typecheck           # Frontend and Worker TypeScript validation
npm run lint                # ESLint validation
npm run db:migrate:local    # Apply D1 migrations locally
npm run db:migrate:remote   # Apply D1 migrations to the deployed DB binding
bun run deploy              # Build and deploy Worker application to Cloudflare
bun run benchmark           # Run paid sequential provider timing benchmark
bun run secrets:push        # Upload filtered application secrets to production Worker
```
