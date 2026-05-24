# Add Grok Imagine Models

## Terminology

- The image model requested here is Replicate model `xai/grok-imagine-image-quality` (not `grok-image-image-quality`).
- The future video model is Replicate model `xai/grok-imagine-r2v`.
- `openai/gpt-image-2` remains the existing Replicate image model and the default unless product requirements later change.
- Seedance video generation is not implemented or specified in this repository yet. This document only reserves Grok R2V as an equivalent selectable model in that future video feature.

## Goals

1. Add `xai/grok-imagine-image-quality` as an alternative still-image generation model alongside `openai/gpt-image-2`.
2. Keep all Grok execution behind Replicate, using the existing Replicate token, prediction polling, signed webhook, and output-import lifecycle.
3. Preserve current GPT Image 2 reference-image behavior; do not silently reduce capabilities when Grok is selected.
4. Define where `xai/grok-imagine-r2v` belongs in the future video-generation architecture that will also support Seedance.

## Non-Goals

- Do not integrate directly with `api.x.ai` or add `XAI_API_KEY`.
- Do not replace `openai/gpt-image-2` as the default model in this change.
- Do not implement Grok video, Seedance, MP4 storage, or video UI as part of the still-image change.
- Do not represent existing multi-reference edits as supported by Grok Image Quality without verifying a Replicate input schema that accepts them.

## Existing Behavior

- The application submits official Replicate predictions from `worker/services/generations.ts` and stores `replicate_prediction_id` on each turn.
- Production completion is persisted by the signed Replicate webhook in `worker/index.ts`; local completion is reconciled through the existing generation SSE endpoint.
- `worker/lib/values.ts` currently hard-codes the Replicate model as `openai/gpt-image-2`.
- GPT Image 2 turns can include up to four Person references, two uploaded attachments, and, for modifications, the previous generated image as an edit base.
- Completed output handling assumes a PNG image master in R2 and WebP thumbnail/preview transformations through `IMAGES`.

## Phase 1: Grok Image Quality

### Model Choice

Add the following image-model choices to the image composer:

| UI Label | Replicate Model Slug | Intended Use |
| --- | --- | --- |
| GPT Image 2 | `openai/gpt-image-2` | Current full image workflow, including multi-reference generations and modifications |
| Grok Imagine Quality | `xai/grok-imagine-image-quality` | High-fidelity text-to-image output |

When a client omits the model, the API must continue to select `openai/gpt-image-2` so existing behavior and saved clients remain valid.

### Supported Grok V1 Operation

Grok Image Quality v1 supports text-to-image turns only:

| Operation | GPT Image 2 | Grok Imagine Quality V1 |
| --- | --- | --- |
| Text-only initial generation | Supported | Supported |
| Initial generation with People references | Supported | Not supported |
| Initial generation with attachments | Supported | Not supported |
| Modification from a previous output | Supported | Not supported in v1 |
| Regenerate a text-only turn using its original model/settings | Supported | Supported |

Rationale: the Replicate Grok Image Quality documentation exposes one optional `image` input in editing mode. The current product submits ordered `input_images` for identity/reference composition and can require up to seven images. Selecting Grok must not quietly discard or reinterpret those inputs as an edit of one arbitrary reference image.

### User Experience

- Add a model picker in the image composer with `GPT Image 2` selected by default.
- When `Grok Imagine Quality` is selected, disable Person tagging and attachment upload for the turn and explain that Grok reference/edit support is not yet available in this workflow.
- Do not offer Grok while composing a modification of an existing conversation output in v1; keep that turn on GPT Image 2 or require the user to start a new image generation.
- Display the generating turn's model in gallery/detail metadata using a human-readable label.

### Grok Settings

Replicate documents these inputs for `xai/grok-imagine-image-quality`:

| Input | Supported Values / Behavior |
| --- | --- |
| `prompt` | Required text prompt |
| `image` | Optional single editing image; excluded from v1 product behavior |
| `aspect_ratio` | Output aspect ratio; current app values `1:1`, `3:2`, and `2:3` are compatible |
| `resolution` | `1k` or `2k`; Replicate documents `2k` as the default |

Add an image resolution option when Grok is selected:

| UI Option | Replicate Input | Price Per Output Image |
| --- | --- | ---: |
| 1K | `resolution: "1k"` | $0.05 |
| 2K | `resolution: "2k"` | $0.07 |

- Default Grok resolution to `2k` to match Replicate's documented default.
- Continue to show the current `low` / `medium` / `high` quality option only for GPT Image 2; it must not be passed to Grok.

### API Contract

Extend `POST /api/generations` multipart inputs for image turns:

| Field | Values | Default | Validation |
| --- | --- | --- | --- |
| `model` | `openai/gpt-image-2`, `xai/grok-imagine-image-quality` | `openai/gpt-image-2` | Reject unknown model values |
| `quality` | Existing `low`, `medium`, `high` | Existing default for GPT Image 2 | Accepted only for GPT Image 2 |
| `resolution` | `1k`, `2k` | `2k` for Grok | Accepted only for Grok Image Quality |

For `xai/grok-imagine-image-quality`, reject any request containing `personIds`, `attachments`, `conversationId`, or `parentTurnId` in v1 with a stable 4xx error code such as `MODEL_INPUTS_UNSUPPORTED`.

### Persistence

Turns must persist the selected model and the model-specific setting needed to regenerate accurately.

- Continue storing the exact Replicate slug in `turns.model`.
- Make `quality` an optional GPT Image 2 setting rather than treating it as universal across image models.
- Add a nullable `resolution` turn setting for Grok Image Quality (`1k` or `2k`).
- Update API types and adapters so a turn can return `quality: null` for Grok and `resolution: null` for GPT Image 2.
- Regeneration must use the original turn's `model`, `quality`, and `resolution`; it must not use the current composer defaults.

The schema change may require rebuilding the D1 `turns` table to relax the existing `quality TEXT NOT NULL` column. Preserve all existing turn/link/input lineage during that migration.

### Worker Submission Logic

Replace the single global prediction payload with a model-aware payload selected from `turn.model`.

GPT Image 2 behavior remains equivalent to the current request:

```json
{
  "prompt": "<compiled prompt>",
  "input_images": ["<uploaded reference urls>"],
  "aspect_ratio": "3:2",
  "quality": "medium",
  "number_of_images": 1,
  "output_format": "png",
  "background": "auto",
  "moderation": "auto"
}
```

Grok Image Quality v1 request:

```json
{
  "prompt": "<authored prompt>",
  "aspect_ratio": "3:2",
  "resolution": "2k"
}
```

- Submit both models through `POST /v1/models/{owner}/{name}/predictions` using `REPLICATE_API_TOKEN`.
- Continue attaching the production webhook URL and `webhook_events_filter: ["completed"]` for both models.
- Continue using the existing Replicate prediction polling and cancellation endpoints for both models.
- The text-only Grok request should use the authored prompt; no reference-image instructions need to be compiled when no inputs exist.

### Output Storage

The current output importer writes all completed generation responses as PNG masters. Grok documentation does not guarantee that the returned downloaded bytes are PNG.

- Do not store Grok bytes under a `.png` R2 key with `image/png` metadata without verifying or normalizing the response.
- Preserve the current product invariant of PNG generation masters by normalizing a completed Grok image through `IMAGES` to PNG before it is written to R2, or persist the detected output MIME type and update all image-master assumptions consistently.
- Thumbnail and preview output remains dynamically transformed WebP as today.

### Cost Display

Expose model pricing in the model/resolution selection UI or supporting copy:

| Model / Setting | Output Cost | Input Cost Relevant To V1 |
| --- | ---: | ---: |
| GPT Image 2 | Existing provider pricing | Existing provider pricing |
| Grok Imagine Quality 1K | $0.05 / image | None for text-only v1 |
| Grok Imagine Quality 2K | $0.07 / image | None for text-only v1 |

If Grok editing is added later, Replicate documents an additional `$0.01` for the input image.

## Phase 2: Future Video Generation Slot

Video generation is a separate feature from Phase 1. When a Seedance-backed video flow is designed, expose `xai/grok-imagine-r2v` as an alternative video model in the same provider-agnostic video UI/API rather than creating a Grok-only workflow.

### Future Video Model Role

| Video Model | Purpose |
| --- | --- |
| Seedance model, to be selected in its own specification | Future baseline/general video generation option |
| `xai/grok-imagine-r2v` | Reference-to-video option for videos grounded in existing image references |

Do not assume a Seedance Replicate slug or exact Seedance limits until its implementation is specified and verified.

### Grok R2V Verified Input Surface

Replicate documents `xai/grok-imagine-r2v` as follows:

| Input | Limit / Values |
| --- | --- |
| `prompt` | Required; up to 4,096 characters |
| `reference_images` | 1 to 7 images; `jpg`, `jpeg`, `png`, `webp` |
| `duration` | 1 to 10 seconds |
| `resolution` | `480p`, `720p` |
| `aspect_ratio` | `16:9`, `9:16`, `1:1`, `4:3`, `3:4`, `3:2`, `2:3` |

- R2V cannot be combined with an image-to-video `image` input or video-editing `video` input.
- Replicate advises reducing very large reference images below approximately 4,000 pixels on their longest side before submission.
- Its seven-reference maximum aligns with the current application's maximum modification context of one edit base, four People, and two attachments.

### Future Video Requirements

Before either Seedance or Grok R2V can ship, the shared video feature must add:

- Media-aware turns/assets that distinguish image output from video output and store MP4 MIME/type metadata.
- R2 persistence for downloaded Replicate video output instead of retaining temporary provider URLs.
- Asset routes and UI components that stream/render video without sending MP4 content through Cloudflare Images transformations.
- Video composer settings including model, duration, aspect ratio, and resolution.
- Gallery and conversation rendering for video outputs and downloads.
- The existing one-active-generation-per-conversation rule for both image and video turns.
- The existing Replicate webhook verification and terminal reconciliation behavior for video predictions.

### Intended R2V Product Mapping

When the shared video system exists, Grok R2V should reuse the product's existing reference-selection concepts:

| Existing Product Input | Grok R2V Input |
| --- | --- |
| Selected previous image output | One `reference_images` entry |
| Selected People portraits | Ordered `reference_images` entries |
| Uploaded reference attachments | Ordered `reference_images` entries |
| Prompt | `prompt` describing motion, action, camera direction, and audio intent |

Require at least one reference image for Grok R2V. Preserve the submitted order so prompt references and historical turn inputs remain understandable.

## Implementation Order

1. Add model-aware image-turn request, persistence, and UI support for text-only `xai/grok-imagine-image-quality` generations.
2. Normalize or correctly persist Grok completed image media before importing it to gallery storage.
3. Verify image generation, webhook completion, local SSE completion, cancellation, regeneration, gallery rendering, and legacy GPT Image 2 reference workflows.
4. Write the shared video/Seedance specification and select the Seedance model/API surface.
5. Implement shared video asset and turn support.
6. Add `xai/grok-imagine-r2v` as a selectable video model using the shared video system.

## Acceptance Criteria: Grok Image Quality

- A user can create a new text-only image turn with either GPT Image 2 or Grok Imagine Quality.
- Existing clients that omit `model` continue using GPT Image 2.
- A Grok turn persists `xai/grok-imagine-image-quality` and its selected `resolution`, and regenerates with those same settings.
- The UI prevents or the API rejects unsupported Grok v1 reference and modification requests without dropping inputs.
- Grok predictions use existing Replicate authentication, SSE reconciliation, cancellation, and verified production webhook completion.
- Completed Grok image outputs are durably stored in R2 with correct image bytes/MIME metadata and render through existing preview routes.
- Existing GPT Image 2 generation and multi-reference modification workflows continue unchanged.

## Verification Plan: Grok Image Quality

- Run `npm run db:migrate:local` after adding the migration.
- Run `npm run lint`, `npm run typecheck`, and `npm run build`.
- Locally submit a text-only GPT Image 2 turn and verify no behavior regression.
- Locally submit Grok Image Quality `1k` and `2k` turns and verify model/settings metadata, SSE completion, stored output, preview, and download.
- Verify a Grok request with a Person, attachment, or modification input is prevented in the UI and rejected by the API if submitted directly.
- Verify a completed Grok turn can be regenerated with its original model and resolution.
- On an HTTPS test deployment, verify a signed Replicate completion webhook imports Grok output after the browser disconnects.

## Sources

- Replicate Grok Imagine Image Quality: <https://replicate.com/xai/grok-imagine-image-quality>
- Replicate Grok Imagine R2V: <https://replicate.com/xai/grok-imagine-r2v>
- Replicate official models: <https://replicate.com/docs/topics/models/official-models>
- Replicate predictions: <https://replicate.com/docs/topics/predictions/create-a-prediction>
- Replicate webhook setup: <https://replicate.com/docs/topics/webhooks/setup-webhook>
- Replicate webhook verification: <https://replicate.com/docs/topics/webhooks/verify-webhook>
