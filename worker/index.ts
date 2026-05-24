import { Hono, type Context } from "hono"
import { streamSSE } from "hono/streaming"
import { validateWebhook, type Prediction } from "replicate"

import type { AppVariables, AssetRow, ConversationRow, Env, PersonRow, TurnKind, TurnRow } from "./types"
import { ApiError, errorResponse } from "./lib/errors"
import {
  MAX_ATTACHMENTS_PER_TURN,
  MAX_PEOPLE_PER_TURN,
  DEFAULT_IMAGE_MODEL,
  GROK_IMAGE_MODEL,
  PERSON_COLOR_TOKENS,
  cleanHandle,
  cleanPrompt,
  id,
  now,
  parseAspectRatio,
  parseImageModel,
  parseQuality,
  parseResolution,
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

api.onError((error, c) => errorResponse(c, error))

api.get("/health", (c) => c.json({ ok: true }))

api.get("/assets/:id/content", async (c) => {
  const asset = await getAsset(c.env, c.req.param("id"))
  const variant = c.req.query("variant")
  if (variant && variant !== "thumbnail" && variant !== "preview") {
    throw new ApiError(400, "INVALID_ASSET_VARIANT", "Unsupported asset display variant.")
  }
  return serveAsset(c.env, asset, variant ?? null, c.req.query("download") === "1")
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
    throw new ApiError(400, "INVALID_PERSON", "Name and mention name are required.")
  }
  if (!(image instanceof File)) {
    throw new ApiError(400, "INVALID_IMAGE", "A portrait image is required.")
  }
  const duplicate = await c.env.DB.prepare("SELECT id FROM people WHERE handle = ?").bind(handle).first()
  if (duplicate) {
    throw new ApiError(409, "HANDLE_ALREADY_EXISTS", "That mention name is already in use.")
  }

  const personId = id()
  const stored = await normalizeAndStoreImage(c.env, image, {
    kind: "person_reference",
    prefix: `people/${personId}`,
    maxDimension: 1536,
    quality: 90,
  })
  const timestamp = now()
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM people").first<{ count: number }>()
  const color = PERSON_COLOR_TOKENS[(count?.count ?? 0) % PERSON_COLOR_TOKENS.length]
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
  const person = await c.env.DB.prepare("SELECT * FROM people WHERE id = ?").bind(personId).first<PersonRow>()
  return c.json({ person: publicPerson(person!) }, 201)
})

api.patch("/people/:id", async (c) => {
  const body = await c.req.json<{ name?: string; handle?: string }>()
  const personId = c.req.param("id")
  const existing = await activePerson(c.env, personId)
  const name = body.name?.trim() || existing.name
  const handle = body.handle === undefined ? existing.handle : cleanHandle(body.handle)
  if (!handle) {
    throw new ApiError(400, "INVALID_PERSON", "Mention name may not be empty.")
  }
  const duplicate = await c.env.DB.prepare("SELECT id FROM people WHERE handle = ? AND id != ?")
    .bind(handle, personId)
    .first()
  if (duplicate) {
    throw new ApiError(409, "HANDLE_ALREADY_EXISTS", "That mention name is already in use.")
  }
  await c.env.DB.prepare("UPDATE people SET name = ?, handle = ?, updated_at = ? WHERE id = ?")
    .bind(name, handle, now(), personId)
    .run()
  return c.json({ person: publicPerson({ ...existing, name, handle }) })
})

api.delete("/people/:id", async (c) => {
  await activePerson(c.env, c.req.param("id"))
  await c.env.DB.prepare("UPDATE people SET archived_at = ?, updated_at = ? WHERE id = ? AND archived_at IS NULL")
    .bind(now(), now(), c.req.param("id"))
    .run()
  return c.body(null, 204)
})

api.get("/conversations", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT * FROM conversations WHERE deleted_at IS NULL ORDER BY updated_at DESC"
  ).all<ConversationRow>()
  const conversations = await Promise.all(rows.results.map(async (conversation) => {
    const latestOutput = await c.env.DB.prepare(
      "SELECT turns.output_asset_id FROM conversation_turn_links JOIN turns ON turns.id = conversation_turn_links.turn_id JOIN assets ON assets.id = turns.output_asset_id WHERE conversation_turn_links.conversation_id = ? AND turns.status = 'succeeded' AND assets.deleted_at IS NULL ORDER BY conversation_turn_links.position DESC LIMIT 1"
    ).bind(conversation.id).first<{ output_asset_id: string }>()
    return {
      ...conversation,
      previewSrc: latestOutput ? assetUrl(latestOutput.output_asset_id, "thumbnail") : null,
    }
  }))
  return c.json({ conversations })
})

api.get("/conversations/:id", async (c) => {
  const conversation = await requireConversation(c.env, c.req.param("id"), false)
  const turns = await c.env.DB.prepare(
    "SELECT turns.*, conversation_turn_links.is_snapshot, conversation_turn_links.is_fork_point, conversation_turn_links.position FROM conversation_turn_links JOIN turns ON turns.id = conversation_turn_links.turn_id WHERE conversation_turn_links.conversation_id = ? ORDER BY conversation_turn_links.position"
  )
    .bind(conversation.id)
    .all<TurnRow & { is_snapshot: number; is_fork_point: number; position: number }>()
  const publicTurns = await Promise.all(turns.results.map(async (turn) => ({
    ...publicTurn(turn),
    isSnapshot: Boolean(turn.is_snapshot),
    isForkPoint: Boolean(turn.is_fork_point),
    inputs: await publicTurnInputs(c.env, turn.id),
  })))
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
    throw new ApiError(400, "INVALID_TITLE", "Conversation title may not be empty.")
  }
  await c.env.DB.prepare("UPDATE conversations SET title = ?, title_status = 'generated', updated_at = ? WHERE id = ?")
    .bind(title.slice(0, 80), now(), conversation.id)
    .run()
  return c.json({ conversation: { ...conversation, title: title.slice(0, 80), title_status: "generated", updated_at: now() } })
})

api.delete("/conversations/:id", async (c) => {
  const conversation = await requireConversation(c.env, c.req.param("id"), true)
  await c.env.DB.prepare("UPDATE conversations SET deleted_at = ?, updated_at = ? WHERE id = ?")
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
  return c.json({ turn: publicTurn(turn) })
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
        const event = turn.status === "succeeded" ? "completed" : turn.status === "failed" || turn.status === "canceled" ? turn.status : "status"
        await stream.writeSSE({ event, data: JSON.stringify(publicTurn(turn)) })
        lastStatus = turn.status
      }
      if (isTerminal(turn.status)) {
        return
      }
      await stream.sleep(1500)
    }
    await stream.writeSSE({ event: "timeout", data: JSON.stringify({ turnId }) })
  })
})

api.post("/generations/:id/cancel", async (c) => {
  const turn = await cancelTurn(c.env, c.req.param("id"))
  return c.json({ turn: publicTurn(turn) })
})

api.post("/generations/:id/regenerate", async (c) => {
  const source = await findTurn(c.env, c.req.param("id"))
  if (source.status !== "succeeded" && source.status !== "failed" && source.status !== "canceled") {
    throw new ApiError(409, "TURN_IN_PROGRESS", "A generation still in progress cannot be rerun.")
  }
  const body: { conversationId?: string } = await c.req.json<{ conversationId?: string }>().catch(() => ({}))
  const conversationId = body.conversationId ?? source.conversation_id
  await ensureConversationAvailable(c.env, conversationId)
  const linked = await c.env.DB.prepare("SELECT turn_id FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?")
    .bind(conversationId, source.id).first()
  if (!linked) {
    throw new ApiError(409, "TURN_NOT_IN_CONVERSATION", "The selected output is not in this conversation.")
  }
  const turnId = id()
  const timestamp = now()
  const inputRows = await loadTurnInputs(c.env, source.id)
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO turns (id, conversation_id, parent_turn_id, kind, authored_prompt, compiled_prompt, model, aspect_ratio, quality, resolution, output_format, status, created_at) VALUES (?, ?, ?, 'regeneration', ?, ?, ?, ?, ?, ?, 'png', 'queued', ?)"
    ).bind(turnId, conversationId, source.parent_turn_id, source.authored_prompt, source.compiled_prompt, source.model, source.aspect_ratio, source.quality, source.resolution, timestamp),
    ...inputRows.map((input) => c.env.DB.prepare(
      "INSERT INTO turn_inputs (turn_id, asset_id, person_id, role, ordinal) VALUES (?, ?, ?, ?, ?)"
    ).bind(turnId, input.asset_id, input.person_id, input.role, input.ordinal)),
    c.env.DB.prepare(
      "INSERT INTO conversation_turn_links (conversation_id, turn_id, position) SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM conversation_turn_links WHERE conversation_id = ?"
    ).bind(conversationId, turnId, conversationId),
    c.env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(timestamp, conversationId),
  ])
  const turn = await findTurn(c.env, turnId)
  await submitTurnPrediction(c, turn)
  return c.json({ turn: publicTurn(await findTurn(c.env, turnId)) }, 202)
})

api.post("/turns/:id/fork", async (c) => {
  const source = await findTurn(c.env, c.req.param("id"))
  if (source.status !== "succeeded" || !source.output_asset_id) {
    throw new ApiError(409, "TURN_NOT_COMPLETE", "Only completed outputs can be forked.")
  }
  await getAsset(c.env, source.output_asset_id)
  const sourceConversation = await requireConversation(c.env, source.conversation_id, false)
  const lineage = await c.env.DB.prepare(
    "SELECT turn_id, position FROM conversation_turn_links WHERE conversation_id = ? AND position <= (SELECT position FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?) ORDER BY position"
  ).bind(source.conversation_id, source.conversation_id, source.id).all<{ turn_id: string; position: number }>()
  if (lineage.results.length === 0) {
    throw new ApiError(409, "FORK_LINEAGE_MISSING", "This output no longer has a forkable conversation lineage.")
  }
  const conversationId = id()
  const timestamp = now()
  const fallbackTitle = `${sourceConversation.title} fork`.slice(0, 80)
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO conversations (id, title, title_status, forked_from_conversation_id, forked_from_turn_id, created_at, updated_at) VALUES (?, ?, 'generating', ?, ?, ?, ?)"
    ).bind(conversationId, fallbackTitle, source.conversation_id, source.id, timestamp, timestamp),
    ...lineage.results.map((link, index) => c.env.DB.prepare(
      "INSERT INTO conversation_turn_links (conversation_id, turn_id, position, is_snapshot, is_fork_point) VALUES (?, ?, ?, 1, ?)"
    ).bind(conversationId, link.turn_id, index, link.turn_id === source.id ? 1 : 0)),
  ])
  const context = await lineageTitleContext(c.env, lineage.results.map((entry) => entry.turn_id))
  c.executionCtx.waitUntil(generateConversationTitle(c.env, conversationId, context))
  return c.json({ conversation: await requireConversation(c.env, conversationId, true), focusedTurn: publicTurn(source) }, 201)
})

api.get("/gallery", async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT assets.*, turns.id AS turn_id, turns.authored_prompt, turns.model, turns.aspect_ratio, turns.quality, turns.resolution, turns.conversation_id, conversations.title AS conversation_title, conversations.deleted_at AS conversation_deleted_at FROM assets JOIN turns ON turns.output_asset_id = assets.id LEFT JOIN conversations ON conversations.id = turns.conversation_id WHERE assets.kind = 'generation_output' AND assets.deleted_at IS NULL AND turns.status = 'succeeded' ORDER BY assets.created_at DESC"
  ).all<AssetRow & { turn_id: string; authored_prompt: string; model: string; aspect_ratio: string; quality: string; resolution: string | null; conversation_id: string; conversation_title: string | null; conversation_deleted_at: string | null }>()
  return c.json({ gallery: await Promise.all(rows.results.map((asset) => publicGalleryItem(c.env, asset))) })
})

api.get("/gallery/:id", async (c) => {
  const row = await galleryAsset(c.env, c.req.param("id"))
  return c.json({ item: await publicGalleryItem(c.env, row) })
})

api.delete("/gallery/:id", async (c) => {
  const asset = await galleryAsset(c.env, c.req.param("id"))
  const reference = await c.env.DB.prepare(
    "SELECT conversations.id FROM conversation_turn_links JOIN conversations ON conversations.id = conversation_turn_links.conversation_id JOIN turns ON turns.id = conversation_turn_links.turn_id WHERE turns.output_asset_id = ? AND conversations.deleted_at IS NULL LIMIT 1"
  ).bind(asset.id).first()
  if (reference) {
    throw new ApiError(409, "ASSET_IN_USE", "This image is still referenced by an active conversation.")
  }
  await markAssetDeleted(c.env, asset)
  return c.body(null, 204)
})

api.post("/webhooks/replicate", async (c) => {
  if (!c.env.REPLICATE_WEBHOOK_SIGNING_SECRET) {
    throw new ApiError(503, "WEBHOOK_NOT_CONFIGURED", "Webhook validation is not configured.")
  }
  const turnId = c.req.query("turnId")
  if (!turnId) {
    throw new ApiError(400, "TURN_ID_REQUIRED", "A webhook turn identifier is required.")
  }
  const webhookId = c.req.header("webhook-id")
  const webhookTimestamp = c.req.header("webhook-timestamp")
  const webhookSignature = c.req.header("webhook-signature")
  if (!webhookId || !webhookTimestamp || !webhookSignature) {
    throw new ApiError(400, "WEBHOOK_HEADERS_REQUIRED", "Webhook signature headers are missing.")
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
    return c.json({ error: { code: "WEBHOOK_INVALID", message: "Webhook signature is invalid." } }, 401)
  }
  const prior = await c.env.DB.prepare("SELECT webhook_id FROM webhook_deliveries WHERE webhook_id = ?").bind(webhookId).first()
  if (prior) {
    return c.json({ ok: true, duplicate: true })
  }
  const prediction = JSON.parse(rawBody) as Prediction
  await reconcileTurn(c.env, turnId, prediction)
  await c.env.DB.prepare("INSERT OR IGNORE INTO webhook_deliveries (webhook_id, turn_id, received_at) VALUES (?, ?, ?)")
    .bind(webhookId, turnId, now())
    .run()
  return c.json({ ok: true })
})

async function createGenerationFromRequest(c: Context<App>) {
  const data = await c.req.formData()
  const prompt = cleanPrompt(data.get("prompt"))
  const aspectRatio = parseAspectRatio(data.get("aspectRatio"))
  const model = parseImageModel(data.get("model"))
  if (model === GROK_IMAGE_MODEL && data.has("quality")) {
    throw new ApiError(400, "MODEL_SETTING_UNSUPPORTED", "Quality is only supported for GPT Image 2 generations.")
  }
  if (model === DEFAULT_IMAGE_MODEL && data.has("resolution")) {
    throw new ApiError(400, "MODEL_SETTING_UNSUPPORTED", "Resolution is only supported for Grok Imagine Quality generations.")
  }
  const quality = model === DEFAULT_IMAGE_MODEL ? parseQuality(data.get("quality")) : "medium"
  const resolution = model === GROK_IMAGE_MODEL ? parseResolution(data.get("resolution")) : null
  const requestedPersonIds = [...new Set(data.getAll("personIds").filter((value): value is string => typeof value === "string" && Boolean(value)))]
  if (requestedPersonIds.length > MAX_PEOPLE_PER_TURN) {
    throw new ApiError(400, "TOO_MANY_PEOPLE", `A generation may include up to ${MAX_PEOPLE_PER_TURN} People.`)
  }
  const attachments = data.getAll("attachments").filter((value): value is File => value instanceof File && value.size > 0)
  if (attachments.length > MAX_ATTACHMENTS_PER_TURN) {
    throw new ApiError(400, "TOO_MANY_ATTACHMENTS", `A generation may include up to ${MAX_ATTACHMENTS_PER_TURN} attached reference images.`)
  }
  const suppliedConversationId = stringValue(data.get("conversationId"))
  const parentTurnId = stringValue(data.get("parentTurnId"))
  if (model === GROK_IMAGE_MODEL && requestedPersonIds.length > 0) {
    throw new ApiError(400, "MODEL_INPUTS_UNSUPPORTED", "Grok Imagine Quality does not support People references in this workflow.")
  }
  if (model === GROK_IMAGE_MODEL && !suppliedConversationId && attachments.length > 1) {
    throw new ApiError(400, "MODEL_INPUTS_UNSUPPORTED", "A new Grok generation may include one reference image.")
  }
  if (model === GROK_IMAGE_MODEL && suppliedConversationId && attachments.length > 0) {
    throw new ApiError(400, "MODEL_INPUTS_UNSUPPORTED", "Grok follow-up prompts edit the previous output and cannot include another reference image.")
  }
  const conversationId = suppliedConversationId ?? id()
  const turnId = id()
  const timestamp = now()
  let kind: TurnKind = "generation"
  const inputs: OrderedInput[] = []

  if (suppliedConversationId) {
    await ensureConversationAvailable(c.env, suppliedConversationId)
    if (!parentTurnId) {
      throw new ApiError(400, "PARENT_TURN_REQUIRED", "A prior completed image is required for a modification.")
    }
    const parent = await findTurn(c.env, parentTurnId)
    if (parent.status !== "succeeded" || !parent.output_asset_id) {
      throw new ApiError(409, "PARENT_OUTPUT_MISSING", "The selected previous image is not available for editing.")
    }
    if (parent.model !== model) {
      throw new ApiError(400, "MODEL_CHANGE_UNSUPPORTED", "Follow-up generations must use the conversation's existing model.")
    }
    await getAsset(c.env, parent.output_asset_id)
    const linked = await c.env.DB.prepare("SELECT turn_id FROM conversation_turn_links WHERE conversation_id = ? AND turn_id = ?")
      .bind(suppliedConversationId, parent.id).first()
    if (!linked) {
      throw new ApiError(409, "PARENT_NOT_IN_CONVERSATION", "The selected previous image is not in this conversation.")
    }
    inputs.push({ assetId: parent.output_asset_id, role: "edit_base" })
    kind = "modification"
  }

  const people = await selectedPeople(c.env, requestedPersonIds)
  for (const person of people) {
    inputs.push({ assetId: person.reference_asset_id, role: "person_reference", personHandle: person.handle })
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
    statements.push(c.env.DB.prepare(
      "INSERT INTO conversations (id, title, title_status, created_at, updated_at) VALUES (?, ?, 'generating', ?, ?)"
    ).bind(conversationId, temporaryTitle(prompt), timestamp, timestamp))
  }
  statements.push(c.env.DB.prepare(
    "INSERT INTO turns (id, conversation_id, parent_turn_id, kind, authored_prompt, compiled_prompt, model, aspect_ratio, quality, resolution, output_format, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'png', 'queued', ?)"
  ).bind(turnId, conversationId, parentTurnId, kind, prompt, compiledPrompt, model, aspectRatio, quality, resolution, timestamp))
  statements.push(c.env.DB.prepare(
    "INSERT INTO conversation_turn_links (conversation_id, turn_id, position) SELECT ?, ?, COALESCE(MAX(position), -1) + 1 FROM conversation_turn_links WHERE conversation_id = ?"
  ).bind(conversationId, turnId, conversationId))
  statements.push(c.env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(timestamp, conversationId))
  inputs.forEach((input, ordinal) => {
    const person = input.role === "person_reference" ? people.find((candidate) => candidate.reference_asset_id === input.assetId) : undefined
    statements.push(c.env.DB.prepare(
      "INSERT INTO turn_inputs (turn_id, asset_id, person_id, role, ordinal) VALUES (?, ?, ?, ?, ?)"
    ).bind(turnId, input.assetId, person?.id ?? null, input.role, ordinal))
  })
  await c.env.DB.batch(statements)
  if (!suppliedConversationId) {
    c.executionCtx.waitUntil(generateConversationTitle(c.env, conversationId, prompt))
  }
  const turn = await findTurn(c.env, turnId)
  await submitTurnPrediction(c, turn)
  return c.json({ conversation: await requireConversation(c.env, conversationId, true), turn: publicTurn(await findTurn(c.env, turnId)) }, 202)
}

async function submitTurnPrediction(c: Context<App>, turn: TurnRow) {
  try {
    await recordGenerationEvent(c.env, turn.id, "status", { status: "queued" })
    await createPrediction(c.env, turn, productionWebhookUrl(c.env, turn.id))
  } catch (error) {
    await c.env.DB.prepare("UPDATE turns SET status = 'failed', error_message = ?, completed_at = ? WHERE id = ?")
      .bind(error instanceof Error ? error.message : "Generation could not be started.", now(), turn.id)
      .run()
    await recordGenerationEvent(c.env, turn.id, "failed", { status: "failed" })
    console.error("Prediction submission failed", error)
  }
}

async function ensureConversationAvailable(env: Env, conversationId: string) {
  await requireConversation(env, conversationId, true)
  const busy = await env.DB.prepare(
    "SELECT id FROM turns WHERE conversation_id = ? AND status IN ('queued', 'starting', 'processing', 'persisting') LIMIT 1"
  ).bind(conversationId).first()
  if (busy) {
    throw new ApiError(409, "CONVERSATION_BUSY", "This conversation already has an image processing.")
  }
}

async function requireConversation(env: Env, conversationId: string, activeOnly: boolean) {
  const conversation = await env.DB.prepare("SELECT * FROM conversations WHERE id = ?")
    .bind(conversationId).first<ConversationRow>()
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
  const person = await env.DB.prepare("SELECT * FROM people WHERE id = ? AND archived_at IS NULL")
    .bind(personId).first<PersonRow>()
  if (!person) {
    throw new ApiError(404, "PERSON_NOT_FOUND", "Person not found or no longer available.")
  }
  return person
}

async function galleryAsset(env: Env, assetId: string) {
  const row = await env.DB.prepare(
    "SELECT assets.*, turns.id AS turn_id, turns.authored_prompt, turns.model, turns.aspect_ratio, turns.quality, turns.resolution, turns.conversation_id, conversations.title AS conversation_title, conversations.deleted_at AS conversation_deleted_at FROM assets JOIN turns ON turns.output_asset_id = assets.id LEFT JOIN conversations ON conversations.id = turns.conversation_id WHERE assets.id = ? AND assets.kind = 'generation_output' AND assets.deleted_at IS NULL AND turns.status = 'succeeded'"
  ).bind(assetId).first<AssetRow & { turn_id: string; authored_prompt: string; model: string; aspect_ratio: string; quality: string; resolution: string | null; conversation_id: string; conversation_title: string | null; conversation_deleted_at: string | null }>()
  if (!row) {
    throw new ApiError(404, "GALLERY_ITEM_NOT_FOUND", "Gallery image not found.")
  }
  return row
}

async function publicGalleryItem(env: Env, asset: AssetRow & { turn_id: string; authored_prompt: string; model: string; aspect_ratio: string; quality: string; resolution: string | null; conversation_id: string; conversation_title: string | null; conversation_deleted_at: string | null }) {
  const activeReference = await env.DB.prepare(
    "SELECT conversations.id FROM conversation_turn_links JOIN conversations ON conversations.id = conversation_turn_links.conversation_id JOIN turns ON turns.id = conversation_turn_links.turn_id WHERE turns.output_asset_id = ? AND conversations.deleted_at IS NULL LIMIT 1"
  ).bind(asset.id).first()
  return {
    assetId: asset.id,
    turnId: asset.turn_id,
    conversationId: asset.conversation_id,
    conversationTitle: asset.conversation_title,
    conversationDeleted: Boolean(asset.conversation_deleted_at),
    prompt: asset.authored_prompt,
    model: asset.model,
    aspectRatio: asset.aspect_ratio,
    quality: asset.model === DEFAULT_IMAGE_MODEL ? asset.quality : null,
    resolution: asset.model === GROK_IMAGE_MODEL ? asset.resolution : null,
    createdAt: asset.created_at,
    thumbnailSrc: assetUrl(asset.id, "thumbnail"),
    previewSrc: assetUrl(asset.id, "preview"),
    downloadSrc: downloadableAssetUrl(asset.id),
    mayDelete: !activeReference,
    mayFork: true,
  }
}

function publicPerson(person: PersonRow) {
  return { ...person, imageSrc: assetUrl(person.reference_asset_id, "thumbnail") }
}

function publicTurn(turn: TurnRow) {
  return {
    ...turn,
    quality: turn.model === DEFAULT_IMAGE_MODEL ? turn.quality : null,
    resolution: turn.model === GROK_IMAGE_MODEL ? turn.resolution : null,
    previewSrc: turn.output_asset_id ? assetUrl(turn.output_asset_id, "preview") : null,
    downloadSrc: turn.output_asset_id ? downloadableAssetUrl(turn.output_asset_id) : null,
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
  ).bind(turnId).all<{
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
    person: input.person_id ? {
      id: input.person_id,
      name: input.person_name,
      handle: input.person_handle,
      colorToken: input.color_token,
    } : null,
  }))
}

function productionWebhookUrl(env: Env, turnId: string) {
  if (!env.PUBLIC_APP_URL || !env.PUBLIC_APP_URL.startsWith("https://")) {
    return undefined
  }
  return `${env.PUBLIC_APP_URL.replace(/\/$/, "")}/api/webhooks/replicate?turnId=${encodeURIComponent(turnId)}`
}

export default api
