# Creator

Image-generation workspace built with React, Vite, shadcn/ui, and a Cloudflare Worker API.

## Runtime

- Frontend: React/Vite SPA using shadcn/ui.
- API: integrated Cloudflare Worker under `/api/*`, implemented with Hono.
- Metadata: Cloudflare D1, with local SQLite-compatible state through Wrangler.
- Media: private Cloudflare R2 bucket.
- Image normalization and preview variants: Cloudflare Images binding.
- Generation: Replicate image models `openai/gpt-image-2` and `xai/grok-imagine-image-quality`, Replicate `xai/grok-imagine-video`, and WaveSpeed `bytedance/seedance-2.0/image-to-video-turbo`.
- Conversation titles: OpenCode Zen `claude-haiku-4-5` through the Anthropic AI SDK provider.

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

`wrangler.jsonc` contains placeholder local configuration. Before deploying, create the remote resources and replace the placeholder D1 database ID:

```bash
npx wrangler d1 create creator-db
npx wrangler r2 bucket create creator-media
```

Set server-side secrets remotely:

```bash
npx wrangler secret put REPLICATE_API_TOKEN
npx wrangler secret put WAVESPEED_API_KEY
npx wrangler secret put OPENCODE_ZEN_API_KEY
npx wrangler secret put REPLICATE_WEBHOOK_SIGNING_SECRET
```

Configure `PUBLIC_APP_URL` to the deployed HTTPS application URL, apply migrations remotely, and deploy:

```bash
npm run db:migrate:remote
npm run deploy
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
```

Generation multipart fields:

```text
prompt          required string
mode            image | video; defaults to image
model           openai/gpt-image-2 | xai/grok-imagine-image-quality; defaults to GPT Image 2
aspectRatio     1:1 | 3:2 | 2:3
quality         low | medium | high; GPT Image 2 only
resolution      1k | 2k; Grok Imagine Quality only, defaults to 2k
personIds       repeatable; maximum four
attachments     repeatable image file; maximum two
conversationId  include for modifications
parentTurnId    include for modifications
```

Initial generations accept at most six image references: four People and two prompt attachments. Modifications also include the immediately previous generated image as the edit base, for at most seven reference images. Only People tagged in the current modification are submitted again.

`xai/grok-imagine-image-quality` supports a text-only new generation or one uploaded reference image on the initial generation. After a Grok output exists, follow-up prompts use that previous output as Grok's single edit image and cannot add more reference images or People. Existing GPT Image 2 multi-reference and modification behavior remains unchanged.

Video mode is available from a completed focused still image and creates a derivative video output without replacing the still-image edit branch. Seedance uses WaveSpeed model `bytedance/seedance-2.0/image-to-video-turbo` with `videoResolution: 720p | 1080p`; Grok video stays on Replicate as `xai/grok-imagine-video` with `videoResolution: 480p | 720p`. Both accept a duration and video-compatible aspect ratio. Seedance accepts `generateAudio`; Grok video includes native synchronized audio without an exposed off switch. Video outputs are persisted as private MP4 assets in R2 and served directly rather than through image transformations.

The API enforces one active generation per conversation. Successful output PNG masters are imported from Replicate into private R2 storage immediately after completion.

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

Production Replicate generations provide Replicate with a completion webhook URL only when `PUBLIC_APP_URL` is HTTPS. Deliveries are signature-validated, idempotent, and used to persist completed outputs even when no browser SSE connection remains active. WaveSpeed Seedance Turbo is currently reconciled through the application's SSE polling path because WaveSpeed's public webhook documentation does not specify signature verification; keep the generating browser session connected until that task is imported into R2.

## Scripts

```bash
npm run dev                 # SPA and Worker local development
npm run build               # Typecheck and Cloudflare/Vite production build
npm run typecheck           # Frontend and Worker TypeScript validation
npm run lint                # ESLint validation
npm run db:migrate:local    # Apply D1 migrations locally
npm run db:migrate:remote   # Apply D1 migrations remotely
npm run deploy              # Build and deploy Worker application
```
