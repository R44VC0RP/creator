import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { validateWebhook, type Prediction } from "replicate"

import type {
  AppVariables,
  AssetRow,
  ConversationRow,
  Env,
  PersonRow,
  TurnKind,
  TurnRow,
} from "./types"
import { ApiError, errorResponse } from "./lib/errors"
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_PEOPLE_PER_TURN,
  DEFAULT_IMAGE_MODEL,
  DEFAULT_VIDEO_MODEL,
  GROK_IMAGE_MODEL,
  GROK_VIDEO_MODEL,
  KLING_VIDEO_MODEL,
  PERSON_COLOR_TOKENS,
  cleanHandle,
  cleanPrompt,
  id,
  now,
  parseAspectRatio,
  parseGenerationMode,
  parseImageModel,
  parseQuality,
  parseVideoAspectRatio,
  parseVideoDuration,
  parseVideoModel,
  parseVideoResolution,
  stringValue,
  temporaryTitle,
} from "./lib/values"
import {
  assetUrl,
  downloadableAssetUrl,
  getAsset,
  markAssetDeleted,
  normalizeAndStoreImage,
  serveAsset,
  serveSharedVideo,
} from "./services/assets"
import {
  cancelTurn,
  compilePrompt,
  createPrediction,
  findTurn,
  isTerminal,
  loadTurnInputs,
  reconcileTurn,
  recordGenerationEvent,
  type OrderedInput,
} from "./services/generations"
import { generateConversationTitle } from "./services/titles"

type App = { Bindings: Env; Variables: AppVariables }
const api = new Hono<App>().basePath("/api")
const share = new Hono<App>()

api.onError((error, c) => errorResponse(c, error))
share.onError((error, c) => errorResponse(c, error))

share.get("/c/:id", async (c) => {
  const conversationId = c.req.param("id")
  const conversation = await sharedConversation(c.env, conversationId)
  const pageResponse = await c.env.ASSETS.fetch(
    new Request(new URL("/index.html", c.req.url), {
      headers: c.req.raw.headers,
    })
  )
  if (!pageResponse.ok || !pageResponse.body) return pageResponse

  const headers = new Headers(pageResponse.headers)
  headers.set("Cache-Control", "private, no-cache")
  const htmlResponse = new Response(pageResponse.body, {
    status: pageResponse.status,
    headers,
  })
  const metadata = shareMetadata(c.req.url, conversationId, conversation)
  return new HTMLRewriter()
    .on("head", {
      element(element) {
        element.append(metadata, { html: true })
      },
    })
    .transform(htmlResponse)
})

share.get("/share/c/:conversationId/image/:assetId/preview.webp", async (c) => {
  const asset = await sharedImageAsset(
    c.env,
    c.req.param("conversationId"),
    c.req.param("assetId")
  )
  const response = await serveAsset(c.env, asset, "preview", false)
  const headers = new Headers(response.headers)
  headers.set("Cache-Control", "public, max-age=3600")
  return new Response(response.body, { status: response.status, headers })
})

async function sharedVideoResponse(c: Context<App>) {
  const conversationId = c.req.param("conversationId")
  const assetId = c.req.param("assetId")
  if (!conversationId || !assetId) {
    throw new ApiError(
      404,
      "SHARE_ASSET_NOT_FOUND",
      "The shared video asset does not exist."
    )
  }
  const asset = await sharedVideoAsset(c.env, conversationId, assetId)
  return serveSharedVideo(c.env, asset, c.req.raw)
}

share.get(
  "/share/c/:conversationId/video/:assetId/video.mp4",
  sharedVideoResponse
)
share.on(
  "HEAD",
  "/share/c/:conversationId/video/:assetId/video.mp4",
  sharedVideoResponse
)

api.get("/health", (c) => c.json({ ok: true }))

api.get("/assets/:id/content", async (c) => {
  const asset = await getAsset(c.env, c.req.param("id"))
  const variant = c.req.query("variant")
  if (variant && variant !== "thumbnail" && variant !== "preview") {
    throw new ApiError(
      400,
      "INVALID_ASSET_VARIANT",
      "Unsupported asset display variant."
    )
  }
  return serveAsset(
    c.env,
    asset,
    variant ?? null,
    c.req.query("download") === "1"
  )
})

api.get("/people", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT people.* FROM people WHERE people.archived_at IS NULL ORDER BY people.created_at DESC"
  ).all<PersonRow>()
  return c.json({ people: rows.results.map(publicPerson) })
})

api.post("/people", async (c) => {
  const data = await c.req.formData()
  const name = stringValue(data.get("name"))
  const handle = cleanHandle(String(data.get("handle") ?? ""))
  const image = data.get("image")
  if (!name || !handle) {
    throw new ApiError(
      400,
      "INVALID_PERSON",
      "Name and mention name are required."
    )
  }
  if (!(image instanceof File)) {
    throw new ApiError(400, "INVALID_IMAGE", "A portrait image is required.")
  }
  const duplicate = await c.env.DB.prepare(
    "SELECT id FROM people WHERE handle = ?"
  )
    .bind(handle)
    .first()
  if (duplicate) {
    throw new ApiError(
      409,
      "HANDLE_ALREADY_EXISTS",
      "That mention name is already in use."
    )
  }

  const personId = id()
  const stored = await normalizeAndStoreImage(c.env, image, {
    kind: "person_reference",
    prefix: `people/${personId}`,
    maxDimension: 1536,
    quality: 90,
  })
  const timestamp = now()
  const count = await c.env.DB.prepare(
    "SELECT COUNT(*) AS count FROM people"
  ).first<{ count: number }>()
  const color =
    PERSON_COLOR_TOKENS[(count?.count ?? 0) % PERSON_COLOR_TOKENS.length]
  try {
    await c.env.DB.prepare(
      "INSERT INTO people (id, name, handle, color_token, reference_asset_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(personId, name, handle, color, stored.id, timestamp, timestamp)
      .run()
  } catch (error) {
    const asset = await getAsset(c.env, stored.id)
    await markAssetDeleted(c.env, asset)
    throw error
  }
  const person = await c.env.DB.prepare("SELECT * FROM people WHERE id = ?")
    .bind(personId)
    .first<PersonRow>()
  return c.json({ person: publicPerson(person!) }, 201)
})

api.patch("/people/:id", async (c) => {
  const body = await c.req.json<{ name?: string; handle?: string }>()
  const personId = c.req.param("id")
  const existing = await activePerson(c.env, personId)
  const name = body.name?.trim() || existing.name
  const handle =
    body.handle === undefined ? existing.handle : cleanHandle(body.handle)
  if (!handle) {
    throw new ApiError(400, "INVALID_PERSON", "Mention name may not be empty.")
  }
  const duplicate = await c.env.DB.prepare(
    "SELECT id FROM people WHERE handle = ? AND id != ?"
  )
    .bind(handle, personId)
    .first()
  if (duplicate) {
    throw new ApiError(
      409,
      "HANDLE_ALREADY_EXISTS",
      "That mention name is already in use."
    )
  }
  await c.env.DB.prepare(
    "UPDATE people SET name = ?, handle = ?, updated_at = ? WHERE id = ?"
  )
    .bind(name, handle, now(), personId)
    .run()
  return c.json({ person: publicPerson({ ...existing, name, handle }) })
})

api.delete("/people/:id", async (c) => {
  await activePerson(c.env, c.req.param("id"))
  await c.env.DB.prepare(
    "UPDATE people SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL"
  )
    .bind(now(), now(), c.req.param("id"))
    .run()
  return c.body(null, 204)
})

api.get("/conversations", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC"
  ).all<ConversationRow>()
  const conversations = await Promise.all(
    rows.results.map(async (conversation) => {
      const latestOutput = await c.env.DB.prepare(
        "SELECT assets.id, assets.mime_type, assets.source_asset_id FROM conversation_turn_links JOIN turns ON turns.id = conversation_turn_links.turn_id JOIN assets ON assets.id = turns.output_asset_id WHERE conversation_turn_links.conversation_id = ? AND turns.status = 'succeeded' AND assets.deleted_at IS NULL ORDER BY conversation_turn_links.position DESC LIMIT 1"
      )
        .bind(conversation.id)
        .first<{
          id: string
          mime_type: string
          source_asset_id: string | null
        }>()
      const previewAssetId =
        latestOutput?.mime_type === "video/mp4"
          ? latestOutput.source_asset_id
          : latestOutput?.id
      return {
        ...conversation,
        previewSrc: previewAssetId
          ? assetUrl(previewAssetId, "thumbnail")
          : null,
      }
    })
  )
  return c.json({ conversations })
})

api.get("/conversations/:id", async (c) => {
  const conversation = await requireConversation(
    c.env,
    c.req.param("id"),
    false
  )
  await reconcileActiveConversationTurn(c.env, conversation.id)
  const turns = await c.env.DB.prepare(
    "SELECT turns.*, conversation_turn_links.is_snapshot, conversation_turn_links.is_fork_point, conversation_turn_links.position FROM conversation_turn_links JOIN turns ON turns.id = conversation_turn_links.turn_id WHERE conversation_turn_links.conversation_id = ? ORDER BY conversation_turn_links.position"
  )
    .bind(conversation.id)
    .all<
      TurnRow & { is_snapshot: number; is_fork_point: number; position: number }
    >()
  const publicTurns = await Promise.all(
    turns.results.map(async (turn) => ({
      ...(await publicTurn(c.env, turn)),
      isSnapshot: Boolean(turn.is_snapshot),
      isForkPoint: Boolean(turn.is_fork_point),
      inputs: await publicTurnInputs(c.env, turn.id),
    }))
  )
  return c.json({
    conversation,
    turns: publicTurns,
  })
})

api.patch("/conversations/:id", async (c) => {
  const conversation = await requireConversation(c.env, c.req.param("id"), true)
  const body = await c.req.json<{ title?: string }>()
  const title = body.title?.trim()
  if (!title) {
    throw new ApiError(
      400,
      "INVALID_TITLE",
      "Conversation title may not be empty."
    )
  }
  await c.env.DB.prepare(
    "UPDATE conversations SET title = ?, title_status = 'generated', updated_at = ? WHERE id = ?"
  )
    .bind(title.slice(0, 80), now(), conversation.id)
    .run()
  return c.json({
    conversation: {
      ...conversation,
      title: title.slice(0, 80),
      title_status: "generated",
      updated_at: now(),
    },
  })
})

api.delete("/conversations/:id", async (c) => {
  const conversation = await requireConversation(c.env, c.req.param("id"), true)
  await c.env.DB.prepare(
    "UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?"
  )
    .bind(now(), now(), conversation.id)
    .run()
  return c.body(null, 204)
})

api.post("/generations", async (c) => createGenerationFromRequest(c))

api.get("/generations/:id", async (c) => {
  let turn = await findTurn(c.env, c.req.param("id"))
  if (!isTerminal(turn.status) && turn.replicate_prediction_id) {
    turn = await reconcileTurn(c.env, turn.id)
  }
  return c.json({ turn: await publicTurn(c.env, turn) })
})

api.get("/generations/:id/events", async (c) => {
  const turnId = c.req.param("id")
  await findTurn(c.env, turnId)
  return streamSSE(c, async (stream) => {
    let lastStatus: string | null = null
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (stream.closed) {
        return
      }
      let turn = await findTurn(c.env, turnId)
      if (!isTerminal(turn.status) && turn.replicate_prediction_id) {
        turn = await reconcileTurn(c.env, turnId)
      }
      if (turn.status !== lastStatus) {
        const event =
          turn.status === "succeeded"
            ? "completed"
            : turn.status === "failed" || turn.status === "canceled"
              ? turn.status
              : "status"
        await stream.writeSSE({
          event,
          data: JSON.stringify(await publicTurn(c.env, turn)),
        })
        lastStatus = turn.status
      }
      if (isTerminal(turn.status)) {
        return
      }
      await stream.sleep(1500)
    }
    await stream.writeSSE({
      event: "timeout",
      data: JSON.stringify({ turnId }),
    })
  })
})

api.post("/generations/:id/cancel", async (c) => {
  const turn = await cancelTurn(c.env, c.req.param("id"))
  return c.json({ turn: await publicTurn(c.env, turn) })
})

api.post("/generations/:id/regenerate", async (c) => {
  const source = await findTurn(c.env, c.req.param("id"))
  if (
    source.status !== "succeeded" &&
    source.status !== "failed" &&
    source.status !== "canceled"
  ) {
    throw new ApiError(
      409,
      "TURN_IN_PROGRESS",
      "A generation still in progress cannot be rerun."
    )
  }
  const body: { conversationId?: string } = await c.req
    .json<{ conversationId?: string }>()
    .catch(() => ({}))
  const conversationId = body.conversationId ?? source.conversation_id
  await ensureConversationAvailable(c.env, conversationId)
  const linked = await c.env.DB.prepare(
    "SELECT turn_id FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?"
  )
    .bind(conversationId, source.id)
    .first()
  if (!linked) {
    throw new ApiError(
      409,
      "TURN_NOT_IN_CONVERSATION",
      "The selected output is not in this conversation."
    )
  }
  const turnId = id()
  const timestamp = now()
  const inputRows = await loadTurnInputs(c.env, source.id)
  const migrateToCurrentProvider =
    source.generation_mode === "image" ||
    (source.generation_mode === "video" &&
      source.model !== GROK_VIDEO_MODEL &&
      source.model !== KLING_VIDEO_MODEL)
  const model =
    source.generation_mode === "image"
      ? DEFAULT_IMAGE_MODEL
      : migrateToCurrentProvider
        ? DEFAULT_VIDEO_MODEL
        : source.model
  const provider = migrateToCurrentProvider ? "wavespeed" : source.provider
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO turns (id, conversation_id, parent_turn_id, kind, authored_prompt, compiled_prompt, model, provider, generation_mode, aspect_ratio, quality, resolution, video_resolution, delivery_resolution, video_duration, generate_audio, output_format, status, created_at) VALUES (?, ?, ?, 'regeneration', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)"
    ).bind(
      turnId,
      conversationId,
      source.parent_turn_id,
      source.authored_prompt,
      source.compiled_prompt,
      model,
      provider,
      source.generation_mode,
      source.aspect_ratio,
      source.generation_mode === "image"
        ? (source.quality ?? "medium")
        : source.quality,
      source.generation_mode === "image" ? null : source.resolution,
      source.video_resolution,
      source.delivery_resolution,
      source.video_duration,
      source.generate_audio,
      source.output_format,
      timestamp
    ),
    ...inputRows.map((input) =>
      c.env.DB.prepare(
        "INSERT INTO turn_inputs (turn_id, asset_id, person_id, role, ordinal) VALUES (?, ?, ?, ?, ?)"
      ).bind(turnId, input.asset_id, input.person_id, input.role, input.ordinal)
    ),
    c.env.DB.prepare(
      "INSERT INTO conversation_turn_links (conversation_id, turn_id, position) SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM conversation_turn_links WHERE conversation_id = ?"
    ).bind(conversationId, turnId, conversationId),
    c.env.DB.prepare(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    ).bind(timestamp, conversationId),
  ])
  const turn = await findTurn(c.env, turnId)
  await submitTurnPrediction(c, turn)
  return c.json(
    { turn: await publicTurn(c.env, await findTurn(c.env, turnId)) },
    202
  )
})

api.post("/turns/:id/revise", async (c) => {
  const source = await findTurn(c.env, c.req.param("id"))
  if (!isTerminal(source.status)) {
    throw new ApiError(
      409,
      "TURN_IN_PROGRESS",
      "A generation still in progress cannot be revised."
    )
  }
  const body = await c.req.json<{ conversationId?: string; prompt?: string }>()
  const prompt = cleanPrompt(body.prompt ?? null)
  const visibleConversationId = body.conversationId ?? source.conversation_id
  const sourceConversation = await requireConversation(
    c.env,
    visibleConversationId,
    true
  )
  const sourceLink = await c.env.DB.prepare(
    "SELECT position FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?"
  )
    .bind(visibleConversationId, source.id)
    .first<{ position: number }>()
  if (!sourceLink) {
    throw new ApiError(
      409,
      "TURN_NOT_IN_CONVERSATION",
      "The selected prompt is not in this conversation."
    )
  }
  const inherited = await c.env.DB.prepare(
    "SELECT turn_id FROM conversation_turn_links WHERE conversation_id = ? AND position < ? ORDER BY position"
  )
    .bind(visibleConversationId, sourceLink.position)
    .all<{ turn_id: string }>()
  const sourceInputs = await loadTurnInputs(c.env, source.id)
  const compiledInputs: OrderedInput[] = []
  for (const input of sourceInputs) {
    let personHandle: string | undefined
    if (input.person_id) {
      const person = await c.env.DB.prepare(
        "SELECT handle FROM people WHERE id = ?"
      )
        .bind(input.person_id)
        .first<{ handle: string }>()
      personHandle = person?.handle
    }
    compiledInputs.push({
      assetId: input.asset_id,
      role: input.role,
      personHandle,
    })
  }
  const conversationId = id()
  const turnId = id()
  const timestamp = now()
  const compiledPrompt =
    source.generation_mode === "image"
      ? compilePrompt(prompt, compiledInputs)
      : prompt
  const migrateToCurrentProvider =
    source.generation_mode === "image" ||
    (source.generation_mode === "video" &&
      source.model !== GROK_VIDEO_MODEL &&
      source.model !== KLING_VIDEO_MODEL)
  const model =
    source.generation_mode === "image"
      ? DEFAULT_IMAGE_MODEL
      : migrateToCurrentProvider
        ? DEFAULT_VIDEO_MODEL
        : source.model
  const provider = migrateToCurrentProvider ? "wavespeed" : source.provider
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO conversations (id, title, title_status, forked_from_conversation_id, forked_from_turn_id, created_at, updated_at) VALUES (?, ?, 'generating', ?, ?, ?, ?)"
    ).bind(
      conversationId,
      temporaryTitle(prompt),
      sourceConversation.id,
      source.id,
      timestamp,
      timestamp
    ),
    ...inherited.results.map((entry, index) =>
      c.env.DB.prepare(
        "INSERT INTO conversation_turn_links (conversation_id, turn_id, position, is_snapshot, is_fork_point) VALUES (?, ?, ?, 1, ?)"
      ).bind(
        conversationId,
        entry.turn_id,
        index,
        index === inherited.results.length - 1 ? 1 : 0
      )
    ),
    c.env.DB.prepare(
      "INSERT INTO turns (id, conversation_id, parent_turn_id, kind, authored_prompt, compiled_prompt, model, provider, generation_mode, aspect_ratio, quality, resolution, video_resolution, delivery_resolution, video_duration, generate_audio, output_format, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)"
    ).bind(
      turnId,
      conversationId,
      source.parent_turn_id,
      source.kind,
      prompt,
      compiledPrompt,
      model,
      provider,
      source.generation_mode,
      source.aspect_ratio,
      source.generation_mode === "image"
        ? (source.quality ?? "medium")
        : source.quality,
      source.generation_mode === "image" ? null : source.resolution,
      source.video_resolution,
      source.delivery_resolution,
      source.video_duration,
      source.generate_audio,
      source.output_format,
      timestamp
    ),
    ...sourceInputs.map((input) =>
      c.env.DB.prepare(
        "INSERT INTO turn_inputs (turn_id, asset_id, person_id, role, ordinal) VALUES (?, ?, ?, ?, ?)"
      ).bind(turnId, input.asset_id, input.person_id, input.role, input.ordinal)
    ),
    c.env.DB.prepare(
      "INSERT INTO conversation_turn_links (conversation_id, turn_id, position) VALUES (?, ?, ?)"
    ).bind(conversationId, turnId, inherited.results.length),
  ])
  c.executionCtx.waitUntil(
    generateConversationTitle(c.env, conversationId, prompt)
  )
  const turn = await findTurn(c.env, turnId)
  await submitTurnPrediction(c, turn)
  return c.json(
    {
      conversation: await requireConversation(c.env, conversationId, true),
      turn: await publicTurn(c.env, await findTurn(c.env, turnId)),
    },
    202
  )
})

api.post("/turns/:id/fork", async (c) => {
  const source = await findTurn(c.env, c.req.param("id"))
  if (
    source.generation_mode !== "image" ||
    source.status !== "succeeded" ||
    !source.output_asset_id
  ) {
    throw new ApiError(
      409,
      "TURN_NOT_COMPLETE",
      "Only completed outputs can be forked."
    )
  }
  await getAsset(c.env, source.output_asset_id)
  const sourceConversation = await requireConversation(
    c.env,
    source.conversation_id,
    false
  )
  const lineage = await c.env.DB.prepare(
    "SELECT turn_id, position FROM conversation_turn_links WHERE conversation_id = ? AND position <= (SELECT position FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?) ORDER BY position"
  )
    .bind(source.conversation_id, source.conversation_id, source.id)
    .all<{ turn_id: string; position: number }>()
  if (lineage.results.length === 0) {
    throw new ApiError(
      409,
      "FORK_LINEAGE_MISSING",
      "This output no longer has a forkable conversation lineage."
    )
  }
  const conversationId = id()
  const timestamp = now()
  const fallbackTitle = `${sourceConversation.title} fork`.slice(0, 80)
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO conversations (id, title, title_status, forked_from_conversation_id, forked_from_turn_id, created_at, updated_at) VALUES (?, ?, 'generating', ?, ?, ?, ?)"
    ).bind(
      conversationId,
      fallbackTitle,
      source.conversation_id,
      source.id,
      timestamp,
      timestamp
    ),
    ...lineage.results.map((link, index) =>
      c.env.DB.prepare(
        "INSERT INTO conversation_turn_links (conversation_id, turn_id, position, is_snapshot, is_fork_point) VALUES (?, ?, ?, 1, ?)"
      ).bind(
        conversationId,
        link.turn_id,
        index,
        link.turn_id === source.id ? 1 : 0
      )
    ),
  ])
  const context = await lineageTitleContext(
    c.env,
    lineage.results.map((entry) => entry.turn_id)
  )
  c.executionCtx.waitUntil(
    generateConversationTitle(c.env, conversationId, context)
  )
  return c.json(
    {
      conversation: await requireConversation(c.env, conversationId, true),
      focusedTurn: await publicTurn(c.env, source),
    },
    201
  )
})

api.get("/gallery", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT assets.*, turns.id AS turn_id, turns.authored_prompt, turns.model, turns.generation_mode, turns.aspect_ratio, turns.quality, turns.resolution, turns.video_resolution, turns.delivery_resolution, turns.video_duration, turns.generate_audio, turns.conversation_id, conversations.title AS conversation_title, conversations.deleted_at AS conversation_deleted_at FROM assets JOIN turns ON turns.output_asset_id = assets.id LEFT JOIN conversations ON conversations.id = turns.conversation_id WHERE assets.kind = 'generation_output' AND assets.deleted_at IS NULL AND turns.status = 'succeeded' ORDER BY assets.created_at DESC"
  ).all<GalleryAssetRow>()
  return c.json({
    gallery: await Promise.all(
      rows.results.map((asset) => publicGalleryItem(c.env, asset))
    ),
  })
})

api.get("/gallery/:id", async (c) => {
  const row = await galleryAsset(c.env, c.req.param("id"))
  return c.json({ item: await publicGalleryItem(c.env, row) })
})

api.delete("/gallery/:id", async (c) => {
  const asset = await galleryAsset(c.env, c.req.param("id"))
  const reference = await c.env.DB.prepare(
    "SELECT conversations.id FROM conversation_turn_links JOIN conversations ON conversations.id = conversation_turn_links.conversation_id JOIN turns ON turns.id = conversation_turn_links.turn_id WHERE turns.output_asset_id = ? AND conversations.deleted_at IS NULL LIMIT 1"
  )
    .bind(asset.id)
    .first()
  if (reference) {
    throw new ApiError(
      409,
      "ASSET_IN_USE",
      "This image is still referenced by an active conversation."
    )
  }
  await markAssetDeleted(c.env, asset)
  return c.body(null, 204)
})

api.post("/webhooks/replicate", async (c) => {
  if (!c.env.REPLICATE_WEBHOOK_SIGNING_SECRET) {
    throw new ApiError(
      503,
      "WEBHOOK_NOT_CONFIGURED",
      "Webhook validation is not configured."
    )
  }
  const turnId = c.req.query("turnId")
  if (!turnId) {
    throw new ApiError(
      400,
      "TURN_ID_REQUIRED",
      "A webhook turn identifier is required."
    )
  }
  const webhookId = c.req.header("webhook-id")
  const webhookTimestamp = c.req.header("webhook-timestamp")
  const webhookSignature = c.req.header("webhook-signature")
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    throw new ApiError(
      400,
      "WEBHOOK_HEADERS_REQUIRED",
      "Webhook signature headers are missing."
    )
  }
  const rawBody = await c.req.text()
  const valid = await validateWebhook({
    id: webhookId,
    timestamp: webhookTimestamp,
    signature: webhookSignature,
    body: rawBody,
    secret: c.env.REPLICATE_WEBHOOK_SIGNING_SECRET,
  })
  if (!valid) {
    return c.json(
      {
        error: {
          code: "WEBHOOK_INVALID",
          message: "Webhook signature is invalid.",
        },
      },
      401
    )
  }
  const prior = await c.env.DB.prepare(
    "SELECT webhook_id FROM webhook_deliveries WHERE webhook_id = ?"
  )
    .bind(webhookId)
    .first()
  if (prior) {
    return c.json({ ok: true, duplicate: true })
  }
  const prediction = JSON.parse(rawBody) as Prediction
  await reconcileTurn(c.env, turnId, prediction)
  await c.env.DB.prepare(
    "INSERT OR IGNORE INTO webhook_deliveries (webhook_id, turn_id, received_at) VALUES (?, ?, ?)"
  )
    .bind(webhookId, turnId, now())
    .run()
  return c.json({ ok: true })
})

async function createGenerationFromRequest(c: Context<App>) {
  const data = await c.req.formData()
  const prompt = cleanPrompt(data.get("prompt"))
  const mode = parseGenerationMode(data.get("mode"))
  const model =
    mode === "video"
      ? parseVideoModel(data.get("model"))
      : parseImageModel(data.get("model"))
  const aspectRatio =
    mode === "video" && model === KLING_VIDEO_MODEL
      ? "adaptive"
      : mode === "video"
        ? parseVideoAspectRatio(data.get("aspectRatio"))
        : parseAspectRatio(data.get("aspectRatio"))
  const quality =
    mode === "image" && model === DEFAULT_IMAGE_MODEL
      ? parseQuality(data.get("quality"))
      : "medium"
  const resolution = null
  const videoResolution =
    mode === "video" && model !== KLING_VIDEO_MODEL
      ? parseVideoResolution(data.get("videoResolution"))
      : null
  const videoDuration =
    mode === "video" ? parseVideoDuration(data.get("duration")) : null
  const generateAudio =
    mode === "video" && model !== GROK_VIDEO_MODEL
      ? data.get("generateAudio") !== "false"
      : mode === "video"
        ? true
        : null
  if (
    mode === "video" &&
    model === GROK_VIDEO_MODEL &&
    data.has("generateAudio")
  ) {
    throw new ApiError(
      400,
      "MODEL_SETTING_UNSUPPORTED",
      "Audio control is available for Seedance and Kling only."
    )
  }
  if (
    mode === "video" &&
    model === DEFAULT_VIDEO_MODEL &&
    videoResolution === "480p"
  ) {
    throw new ApiError(
      400,
      "MODEL_SETTING_UNSUPPORTED",
      "Seedance supports 720p or 1080p in this workflow."
    )
  }
  if (
    mode === "video" &&
    model === GROK_VIDEO_MODEL &&
    videoResolution === "1080p"
  ) {
    throw new ApiError(
      400,
      "MODEL_SETTING_UNSUPPORTED",
      "Grok video supports 480p or 720p."
    )
  }
  if (
    mode === "video" &&
    model === KLING_VIDEO_MODEL &&
    videoDuration !== 5 &&
    videoDuration !== 10
  ) {
    throw new ApiError(
      400,
      "MODEL_SETTING_UNSUPPORTED",
      "Kling O3 Pro supports 5 or 10 second videos."
    )
  }
  const requestedPersonIds = [
    ...new Set(
      data
        .getAll("personIds")
        .filter(
          (value): value is string =>
            typeof value === "string" && Boolean(value)
        )
    ),
  ]
  if (requestedPersonIds.length > MAX_PEOPLE_PER_TURN) {
    throw new ApiError(
      400,
      "TOO_MANY_PEOPLE",
      `A generation may include up to ${MAX_PEOPLE_PER_TURN} People.`
    )
  }
  const attachments = data
    .getAll("attachments")
    .filter((value): value is File => value instanceof File && value.size > 0)
  if (attachments.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new ApiError(
      400,
      "TOO_MANY_ATTACHMENTS",
      `A generation may include up to ${MAX_ATTACHMENTS_PER_TURN} attached reference images.`
    )
  }
  const suppliedConversationId = stringValue(data.get("conversationId"))
  const parentTurnId = stringValue(data.get("parentTurnId"))
  if (
    mode === "video" &&
    (requestedPersonIds.length > 0 || attachments.length > 0)
  ) {
    throw new ApiError(
      400,
      "MODEL_INPUTS_UNSUPPORTED",
      "Video generations use only the focused image and a text prompt."
    )
  }
  const conversationId = suppliedConversationId ?? id()
  const turnId = id()
  const timestamp = now()
  let kind: TurnKind = "generation"
  const inputs: OrderedInput[] = []

  if (mode === "video") {
    if (!suppliedConversationId || !parentTurnId) {
      throw new ApiError(
        400,
        "SOURCE_IMAGE_REQUIRED",
        "Video generation requires a focused generated image."
      )
    }
    await ensureConversationAvailable(c.env, suppliedConversationId)
    const parent = await findTurn(c.env, parentTurnId)
    if (
      parent.generation_mode !== "image" ||
      parent.status !== "succeeded" ||
      !parent.output_asset_id
    ) {
      throw new ApiError(
        409,
        "SOURCE_IMAGE_REQUIRED",
        "Video generation requires a completed image output."
      )
    }
    const sourceAsset = await getAsset(c.env, parent.output_asset_id)
    if (!sourceAsset.mime_type.startsWith("image/")) {
      throw new ApiError(
        409,
        "SOURCE_IMAGE_REQUIRED",
        "Video generation requires an image source."
      )
    }
    const linked = await c.env.DB.prepare(
      "SELECT turn_id FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?"
    )
      .bind(suppliedConversationId, parent.id)
      .first()
    if (!linked) {
      throw new ApiError(
        409,
        "PARENT_NOT_IN_CONVERSATION",
        "The selected image is not in this conversation."
      )
    }
    inputs.push({ assetId: parent.output_asset_id, role: "edit_base" })
  } else if (suppliedConversationId) {
    await ensureConversationAvailable(c.env, suppliedConversationId)
    if (!parentTurnId) {
      throw new ApiError(
        400,
        "PARENT_TURN_REQUIRED",
        "A prior completed image is required for a modification."
      )
    }
    const parent = await findTurn(c.env, parentTurnId)
    if (parent.status !== "succeeded" || !parent.output_asset_id) {
      throw new ApiError(
        409,
        "PARENT_OUTPUT_MISSING",
        "The selected previous image is not available for editing."
      )
    }
    if (
      parent.model !== model &&
      !(model === DEFAULT_IMAGE_MODEL && parent.model === GROK_IMAGE_MODEL)
    ) {
      throw new ApiError(
        400,
        "MODEL_CHANGE_UNSUPPORTED",
        "Follow-up generations must use the conversation's existing model."
      )
    }
    await getAsset(c.env, parent.output_asset_id)
    const linked = await c.env.DB.prepare(
      "SELECT turn_id FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?"
    )
      .bind(suppliedConversationId, parent.id)
      .first()
    if (!linked) {
      throw new ApiError(
        409,
        "PARENT_NOT_IN_CONVERSATION",
        "The selected previous image is not in this conversation."
      )
    }
    inputs.push({ assetId: parent.output_asset_id, role: "edit_base" })
    kind = "modification"
  }

  const people =
    mode === "image" ? await selectedPeople(c.env, requestedPersonIds) : []
  for (const person of people) {
    inputs.push({
      assetId: person.reference_asset_id,
      role: "person_reference",
      personHandle: person.handle,
    })
  }
  for (const attachment of attachments) {
    const stored = await normalizeAndStoreImage(c.env, attachment, {
      kind: "turn_reference",
      prefix: `turn-references/${turnId}`,
      maxDimension: 2048,
      quality: 92,
    })
    inputs.push({ assetId: stored.id, role: "attached_reference" })
  }
  const compiledPrompt = compilePrompt(prompt, inputs)
  const statements: D1PreparedStatement[] = []
  if (!suppliedConversationId) {
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO conversations (id, title, title_status, created_at, updated_at) VALUES (?, ?, 'generating', ?, ?)"
      ).bind(conversationId, temporaryTitle(prompt), timestamp, timestamp)
    )
  }
  statements.push(
    c.env.DB.prepare(
      "INSERT INTO turns (id, conversation_id, parent_turn_id, kind, authored_prompt, compiled_prompt, model, provider, generation_mode, aspect_ratio, quality, resolution, video_resolution, delivery_resolution, video_duration, generate_audio, output_format, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)"
    ).bind(
      turnId,
      conversationId,
      parentTurnId,
      kind,
      prompt,
      compiledPrompt,
      model,
      (mode === "image" && model === DEFAULT_IMAGE_MODEL) ||
        (mode === "video" && model !== GROK_VIDEO_MODEL)
        ? "wavespeed"
        : "replicate",
      mode,
      aspectRatio,
      quality,
      resolution,
      null,
      videoResolution,
      videoDuration,
      generateAudio === null ? null : generateAudio ? 1 : 0,
      mode === "video" ? "mp4" : "png",
      timestamp
    )
  )
  statements.push(
    c.env.DB.prepare(
      "INSERT INTO conversation_turn_links (conversation_id, turn_id, position) SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM conversation_turn_links WHERE conversation_id = ?"
    ).bind(conversationId, turnId, conversationId)
  )
  statements.push(
    c.env.DB.prepare(
      "UPDATE conversations SET updated_at = ? WHERE id = ?"
    ).bind(timestamp, conversationId)
  )
  inputs.forEach((input, ordinal) => {
    const person =
      input.role === "person_reference"
        ? people.find(
            (candidate) => candidate.reference_asset_id === input.assetId
          )
        : undefined
    statements.push(
      c.env.DB.prepare(
        "INSERT INTO turn_inputs (turn_id, asset_id, person_id, role, ordinal) VALUES (?, ?, ?, ?, ?)"
      ).bind(turnId, input.assetId, person?.id ?? null, input.role, ordinal)
    )
  })
  await c.env.DB.batch(statements)
  if (!suppliedConversationId) {
    c.executionCtx.waitUntil(
      generateConversationTitle(c.env, conversationId, prompt)
    )
  }
  const turn = await findTurn(c.env, turnId)
  await submitTurnPrediction(c, turn)
  return c.json(
    {
      conversation: await requireConversation(c.env, conversationId, true),
      turn: await publicTurn(c.env, await findTurn(c.env, turnId)),
    },
    202
  )
}

async function submitTurnPrediction(c: Context<App>, turn: TurnRow) {
  try {
    await recordGenerationEvent(c.env, turn.id, "status", { status: "queued" })
    await createPrediction(c.env, turn, productionWebhookUrl(c.env, turn.id))
  } catch (error) {
    await c.env.DB.prepare(
      "UPDATE turns SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?"
    )
      .bind(
        error instanceof Error
          ? error.message
          : "Generation could not be started.",
        now(),
        turn.id
      )
      .run()
    await recordGenerationEvent(c.env, turn.id, "failed", { status: "failed" })
    console.error("Prediction submission failed", error)
  }
}

async function ensureConversationAvailable(env: Env, conversationId: string) {
  await requireConversation(env, conversationId, true)
  await reconcileActiveConversationTurn(env, conversationId)
  const busy = await activeConversationTurn(env, conversationId)
  if (busy) {
    throw new ApiError(
      409,
      "CONVERSATION_BUSY",
      "This conversation already has a generation in progress."
    )
  }
}

async function activeConversationTurn(env: Env, conversationId: string) {
  return env.DB.prepare(
    "SELECT * FROM turns WHERE conversation_id = ? AND status IN ('queued', 'starting', 'processing', 'persisting') ORDER BY created_at DESC LIMIT 1"
  )
    .bind(conversationId)
    .first<TurnRow>()
}

async function reconcileActiveConversationTurn(
  env: Env,
  conversationId: string
) {
  const activeTurn = await activeConversationTurn(env, conversationId)
  if (activeTurn?.replicate_prediction_id) {
    await reconcileTurn(env, activeTurn.id)
  }
}

async function requireConversation(
  env: Env,
  conversationId: string,
  activeOnly: boolean
) {
  const conversation = await env.DB.prepare(
    "SELECT * FROM conversations WHERE id = ?"
  )
    .bind(conversationId)
    .first<ConversationRow>()
  if (!conversation || (activeOnly && conversation.deleted_at)) {
    throw new ApiError(404, "CONVERSATION_NOT_FOUND", "Conversation not found.")
  }
  return conversation
}

async function selectedPeople(env: Env, ids: string[]) {
  if (ids.length === 0) {
    return []
  }
  const rows: PersonRow[] = []
  for (const personId of ids) {
    rows.push(await activePerson(env, personId))
  }
  return rows
}

async function activePerson(env: Env, personId: string) {
  const person = await env.DB.prepare(
    "SELECT * FROM people WHERE id = ? AND archived_at IS NULL"
  )
    .bind(personId)
    .first<PersonRow>()
  if (!person) {
    throw new ApiError(
      404,
      "PERSON_NOT_FOUND",
      "Person not found or no longer available."
    )
  }
  return person
}

async function galleryAsset(env: Env, assetId: string) {
  const row = await env.DB.prepare(
    "SELECT assets.*, turns.id AS turn_id, turns.authored_prompt, turns.model, turns.generation_mode, turns.aspect_ratio, turns.quality, turns.resolution, turns.video_resolution, turns.delivery_resolution, turns.video_duration, turns.generate_audio, turns.conversation_id, conversations.title AS conversation_title, conversations.deleted_at AS conversation_deleted_at FROM assets JOIN turns ON turns.output_asset_id = assets.id LEFT JOIN conversations ON conversations.id = turns.conversation_id WHERE assets.id = ? AND assets.kind = 'generation_output' AND assets.deleted_at IS NULL AND turns.status = 'succeeded'"
  )
    .bind(assetId)
    .first<GalleryAssetRow>()
  if (!row) {
    throw new ApiError(
      404,
      "GALLERY_ITEM_NOT_FOUND",
      "Gallery image not found."
    )
  }
  return row
}

type GalleryAssetRow = AssetRow & {
  turn_id: string
  authored_prompt: string
  model: string
  generation_mode: string
  aspect_ratio: string
  quality: string
  resolution: string | null
  video_resolution: string | null
  delivery_resolution: string | null
  video_duration: number | null
  generate_audio: number | null
  conversation_id: string
  conversation_title: string | null
  conversation_deleted_at: string | null
}

async function publicGalleryItem(env: Env, asset: GalleryAssetRow) {
  const activeReference = await env.DB.prepare(
    "SELECT conversations.id FROM conversation_turn_links JOIN conversations ON conversations.id = conversation_turn_links.conversation_id JOIN turns ON turns.id = conversation_turn_links.turn_id WHERE turns.output_asset_id = ? AND conversations.deleted_at IS NULL LIMIT 1"
  )
    .bind(asset.id)
    .first()
  const posterAssetId =
    asset.mime_type === "video/mp4" ? asset.source_asset_id : asset.id
  return {
    assetId: asset.id,
    turnId: asset.turn_id,
    conversationId: asset.conversation_id,
    conversationTitle: asset.conversation_title,
    conversationDeleted: Boolean(asset.conversation_deleted_at),
    prompt: asset.authored_prompt,
    model: asset.model,
    mode: asset.generation_mode,
    aspectRatio: asset.aspect_ratio,
    quality: asset.model === DEFAULT_IMAGE_MODEL ? asset.quality : null,
    resolution: asset.model === GROK_IMAGE_MODEL ? asset.resolution : null,
    videoResolution: asset.delivery_resolution ?? asset.video_resolution,
    duration: asset.video_duration,
    generateAudio:
      asset.generate_audio === null ? null : Boolean(asset.generate_audio),
    createdAt: asset.created_at,
    thumbnailSrc: posterAssetId ? assetUrl(posterAssetId, "thumbnail") : null,
    previewSrc: posterAssetId ? assetUrl(posterAssetId, "preview") : null,
    contentSrc: assetUrl(asset.id),
    downloadSrc: downloadableAssetUrl(asset.id),
    mayDelete: !activeReference,
    mayFork: true,
  }
}

function publicPerson(person: PersonRow) {
  return {
    ...person,
    imageSrc: assetUrl(person.reference_asset_id, "thumbnail"),
  }
}

async function publicTurn(env: Env, turn: TurnRow) {
  let posterAssetId = turn.output_asset_id
  if (turn.generation_mode === "video") {
    const source = await env.DB.prepare(
      "SELECT asset_id FROM turn_inputs WHERE turn_id = ? AND role = 'edit_base' ORDER BY ordinal LIMIT 1"
    )
      .bind(turn.id)
      .first<{ asset_id: string }>()
    posterAssetId = source?.asset_id ?? null
  }
  return {
    ...turn,
    quality: turn.model === DEFAULT_IMAGE_MODEL ? turn.quality : null,
    resolution: turn.model === GROK_IMAGE_MODEL ? turn.resolution : null,
    video_resolution: turn.delivery_resolution ?? turn.video_resolution,
    previewSrc: posterAssetId ? assetUrl(posterAssetId, "preview") : null,
    contentSrc: turn.output_asset_id ? assetUrl(turn.output_asset_id) : null,
    downloadSrc: turn.output_asset_id
      ? downloadableAssetUrl(turn.output_asset_id)
      : null,
  }
}

async function lineageTitleContext(env: Env, turnIds: string[]) {
  const prompts: string[] = []
  for (const turnId of turnIds) {
    const turn = await findTurn(env, turnId)
    prompts.push(turn.authored_prompt)
  }
  return prompts.join("\n")
}

async function publicTurnInputs(env: Env, turnId: string) {
  const rows = await env.DB.prepare(
    "SELECT turn_inputs.asset_id, turn_inputs.person_id, turn_inputs.role, turn_inputs.ordinal, assets.deleted_at, people.name AS person_name, people.handle AS person_handle, people.color_token FROM turn_inputs JOIN assets ON assets.id = turn_inputs.asset_id LEFT JOIN people ON people.id = turn_inputs.person_id WHERE turn_inputs.turn_id = ? ORDER BY turn_inputs.ordinal"
  )
    .bind(turnId)
    .all<{
      asset_id: string
      person_id: string | null
      role: string
      ordinal: number
      deleted_at: string | null
      person_name: string | null
      person_handle: string | null
      color_token: string | null
    }>()
  return rows.results.map((input) => ({
    assetId: input.asset_id,
    personId: input.person_id,
    role: input.role,
    ordinal: input.ordinal,
    src: input.deleted_at ? null : assetUrl(input.asset_id, "thumbnail"),
    person: input.person_id
      ? {
          id: input.person_id,
          name: input.person_name,
          handle: input.person_handle,
          colorToken: input.color_token,
        }
      : null,
  }))
}

type SharedConversation = {
  title: string
  output: {
    id: string
    mimeType: string
    posterAssetId: string | null
  } | null
}

async function sharedConversation(
  env: Env,
  conversationId: string
): Promise<SharedConversation | null> {
  const conversation = await env.DB.prepare(
    "SELECT title FROM conversations WHERE id = ? AND deleted_at IS NULL"
  )
    .bind(conversationId)
    .first<{ title: string }>()
  if (!conversation) return null

  const output = await env.DB.prepare(
    "SELECT assets.id, assets.mime_type, assets.source_asset_id FROM conversation_turn_links JOIN turns ON turns.id = conversation_turn_links.turn_id JOIN assets ON assets.id = turns.output_asset_id WHERE conversation_turn_links.conversation_id = ? AND turns.status = 'succeeded' AND assets.deleted_at IS NULL ORDER BY conversation_turn_links.position DESC LIMIT 1"
  )
    .bind(conversationId)
    .first<{
      id: string
      mime_type: string
      source_asset_id: string | null
    }>()
  return {
    title: conversation.title,
    output: output
      ? {
          id: output.id,
          mimeType: output.mime_type,
          posterAssetId:
            output.mime_type === "video/mp4"
              ? output.source_asset_id
              : output.id,
        }
      : null,
  }
}

async function sharedImageAsset(
  env: Env,
  conversationId: string,
  assetId: string
) {
  const asset = await env.DB.prepare(
    "SELECT assets.* FROM assets WHERE assets.id = ? AND assets.deleted_at IS NULL AND assets.r2_key IS NOT NULL AND assets.mime_type LIKE 'image/%' AND (EXISTS (SELECT 1 FROM conversation_turn_links JOIN conversations ON conversations.id = conversation_turn_links.conversation_id JOIN turns ON turns.id = conversation_turn_links.turn_id WHERE conversation_turn_links.conversation_id = ? AND conversations.deleted_at IS NULL AND turns.status = 'succeeded' AND turns.output_asset_id = assets.id) OR EXISTS (SELECT 1 FROM conversation_turn_links JOIN conversations ON conversations.id = conversation_turn_links.conversation_id JOIN turns ON turns.id = conversation_turn_links.turn_id JOIN assets AS video_outputs ON video_outputs.id = turns.output_asset_id WHERE conversation_turn_links.conversation_id = ? AND conversations.deleted_at IS NULL AND turns.status = 'succeeded' AND video_outputs.mime_type = 'video/mp4' AND video_outputs.source_asset_id = assets.id AND video_outputs.deleted_at IS NULL))"
  )
    .bind(assetId, conversationId, conversationId)
    .first<AssetRow>()
  if (!asset) {
    throw new ApiError(
      404,
      "SHARE_ASSET_NOT_FOUND",
      "The shared preview asset does not exist."
    )
  }
  return asset
}

async function sharedVideoAsset(
  env: Env,
  conversationId: string,
  assetId: string
) {
  const asset = await env.DB.prepare(
    "SELECT assets.* FROM assets JOIN turns ON turns.output_asset_id = assets.id JOIN conversation_turn_links ON conversation_turn_links.turn_id = turns.id JOIN conversations ON conversations.id = conversation_turn_links.conversation_id WHERE assets.id = ? AND conversation_turn_links.conversation_id = ? AND conversations.deleted_at IS NULL AND assets.deleted_at IS NULL AND assets.r2_key IS NOT NULL AND assets.mime_type = 'video/mp4' AND turns.status = 'succeeded' LIMIT 1"
  )
    .bind(assetId, conversationId)
    .first<AssetRow>()
  if (!asset) {
    throw new ApiError(
      404,
      "SHARE_ASSET_NOT_FOUND",
      "The shared video asset does not exist."
    )
  }
  return asset
}

function shareMetadata(
  requestUrl: string,
  conversationId: string,
  conversation: SharedConversation | null
) {
  const url = new URL(requestUrl)
  const origin = url.origin
  const mediaQuery = url.search
  const pageUrl = `${origin}/c/${encodeURIComponent(conversationId)}`
  const title = conversation?.title ?? "Anomaly Creator"
  const posterAssetId = conversation?.output?.posterAssetId
  const imageUrl = posterAssetId
    ? `${origin}/share/c/${encodeURIComponent(conversationId)}/image/${encodeURIComponent(posterAssetId)}/preview.webp${mediaQuery}`
    : `${origin}/creator.png`
  const isVideo = conversation?.output?.mimeType === "video/mp4"
  const tags = [
    propertyTag("og:type", isVideo ? "video.other" : "website"),
    propertyTag("og:site_name", "Anomaly Creator"),
    propertyTag("og:title", title),
    propertyTag("og:description", "Created with Anomaly Creator."),
    propertyTag("og:url", pageUrl),
    propertyTag("og:image", imageUrl),
    propertyTag("og:image:secure_url", imageUrl),
    propertyTag("og:image:type", posterAssetId ? "image/webp" : "image/png"),
    propertyTag("og:image:alt", `${title} preview`),
    `<link rel="canonical" href="${escapeHtml(pageUrl)}" />`,
  ]
  if (posterAssetId && !isVideo) {
    tags.push(
      nameTag("twitter:card", "summary_large_image"),
      nameTag("twitter:title", title),
      nameTag("twitter:description", "Created with Anomaly Creator."),
      nameTag("twitter:image", imageUrl),
      nameTag("twitter:image:alt", `${title} preview`)
    )
  }
  if (isVideo && conversation?.output) {
    const videoUrl = `${origin}/share/c/${encodeURIComponent(conversationId)}/video/${encodeURIComponent(conversation.output.id)}/video.mp4${mediaQuery}`
    tags.push(
      propertyTag("og:video", videoUrl),
      propertyTag("og:video:url", videoUrl),
      propertyTag("og:video:secure_url", videoUrl),
      propertyTag("og:video:type", "video/mp4")
    )
  }
  return tags.join("\n")
}

function propertyTag(property: string, content: string) {
  return `<meta property="${property}" content="${escapeHtml(content)}" />`
}

function nameTag(name: string, content: string) {
  return `<meta name="${name}" content="${escapeHtml(content)}" />`
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
}

function productionWebhookUrl(env: Env, turnId: string) {
  if (!env.PUBLIC_APP_URL || !env.PUBLIC_APP_URL.startsWith("https://")) {
    return undefined
  }
  return `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/api/webhooks/replicate?turnId=${encodeURIComponent(turnId)}`
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext) {
    return new URL(request.url).pathname.startsWith("/api/")
      ? api.fetch(request, env, ctx)
      : share.fetch(request, env, ctx)
  },
} satisfies ExportedHandler<Env>
