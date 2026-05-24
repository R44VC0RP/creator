import type { Prediction } from "replicate"

import type { Env, InputRole, TurnInputRow, TurnRow, TurnStatus } from "../types"
import { ApiError } from "../lib/errors"
import { GROK_IMAGE_MODEL, now } from "../lib/values"
import { assetBlob, storeGeneratedOutput } from "./assets"

export type OrderedInput = {
  assetId: string
  role: InputRole
  personHandle?: string
}

function requireReplicateToken(env: Env) {
  if (!env.REPLICATE_API_TOKEN) {
    throw new ApiError(503, "REPLICATE_NOT_CONFIGURED", "Replicate is not configured on this server.")
  }
  return env.REPLICATE_API_TOKEN
}

async function replicateRequest(env: Env, path: string, init?: RequestInit) {
  const token = requireReplicateToken(env)
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${token}`)
  const response = await fetch(`https://api.replicate.com/v1${path}`, { ...init, headers })
  if (!response.ok) {
    const detail = await response.text()
    throw new ApiError(502, "REPLICATE_REQUEST_FAILED", detail || "Replicate request failed.")
  }
  return response
}

async function uploadInputFile(env: Env, blob: Blob, metadata: Record<string, string>) {
  const form = new FormData()
  form.append("content", blob, `reference-${crypto.randomUUID()}.webp`)
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }))
  const response = await replicateRequest(env, "/files", { method: "POST", body: form })
  return response.json() as Promise<{ urls: { get: string } }>
}

async function getPrediction(env: Env, predictionId: string) {
  const response = await replicateRequest(env, `/predictions/${encodeURIComponent(predictionId)}`)
  return response.json() as Promise<Prediction>
}

async function cancelPrediction(env: Env, predictionId: string) {
  const response = await replicateRequest(env, `/predictions/${encodeURIComponent(predictionId)}/cancel`, { method: "POST" })
  return response.json() as Promise<Prediction>
}

export function compilePrompt(authoredPrompt: string, inputs: OrderedInput[]) {
  if (inputs.length === 0) {
    return authoredPrompt
  }

  const references = inputs.map((input, index) => {
    const label = `Image ${index + 1}`
    if (input.role === "edit_base") {
      return `- ${label} is the previous generated image to edit. Preserve details not changed by the request.`
    }
    if (input.role === "person_reference") {
      return `- ${label} is the identity reference for @${input.personHandle}. Preserve this person's facial identity.`
    }
    return `- ${label} is an additional visual reference supplied for this request.`
  })

  return [
    authoredPrompt,
    "",
    "Reference images:",
    ...references,
    "",
    inputs.some((input) => input.role === "edit_base")
      ? "Modify the previous generated image according to the request. Only use explicitly supplied identity references for new identity guidance."
      : "Use tagged identity references only for the named people and follow the requested composition.",
    ...(inputs.some((input) => input.role === "person_reference")
      ? ["For identity reference images, preserve each person's recognizable likeness only. Do not copy the exact pose or facial expression from the reference photo; give them poses and expressions that naturally fit the requested scene."]
      : []),
  ].join("\n")
}

export async function findTurn(env: Env, turnId: string) {
  const turn = await env.DB.prepare("SELECT * FROM turns WHERE id = ?").bind(turnId).first<TurnRow>()
  if (!turn) {
    throw new ApiError(404, "TURN_NOT_FOUND", "Generation turn not found.")
  }
  return turn
}

export async function loadTurnInputs(env: Env, turnId: string) {
  const results = await env.DB.prepare(
    "SELECT turn_inputs.*, assets.r2_key, assets.mime_type, assets.deleted_at FROM turn_inputs JOIN assets ON assets.id = turn_inputs.asset_id WHERE turn_inputs.turn_id = ? ORDER BY turn_inputs.ordinal"
  )
    .bind(turnId)
    .all<TurnInputRow>()
  return results.results
}

export async function recordGenerationEvent(env: Env, turnId: string, eventType: string, payload: unknown) {
  await env.DB.prepare(
    "INSERT INTO generation_events (turn_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)"
  )
    .bind(turnId, eventType, JSON.stringify(payload), now())
    .run()
}

export async function createPrediction(env: Env, turn: TurnRow, webhookUrl?: string) {
  requireReplicateToken(env)
  const storedInputs = await loadTurnInputs(env, turn.id)
  const inputUrls: string[] = []
  for (const input of storedInputs) {
    if (input.deleted_at || !input.r2_key) {
      throw new ApiError(409, "REFERENCE_ASSET_MISSING", "A reference image for this generation is no longer available.")
    }
    const blob = await assetBlob(env, input.asset_id)
    const uploaded = await uploadInputFile(env, blob, { turnId: turn.id, role: input.role })
    inputUrls.push(uploaded.urls.get)
  }

  if (turn.model === GROK_IMAGE_MODEL && inputUrls.length > 1) {
    throw new ApiError(400, "MODEL_INPUTS_UNSUPPORTED", "Grok Imagine Quality accepts only one image input.")
  }

  const input = turn.model === GROK_IMAGE_MODEL
    ? {
        prompt: turn.authored_prompt,
        ...(inputUrls[0] ? { image: inputUrls[0] } : {}),
        aspect_ratio: turn.aspect_ratio,
        resolution: turn.resolution ?? "2k",
      }
    : {
        prompt: turn.compiled_prompt,
        input_images: inputUrls,
        aspect_ratio: turn.aspect_ratio,
        quality: turn.quality,
        number_of_images: 1,
        output_format: "png",
        background: "auto",
        moderation: "auto",
      }

  const response = await replicateRequest(env, `/models/${turn.model}/predictions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      input,
      ...(webhookUrl ? { webhook: webhookUrl, webhook_events_filter: ["completed"] } : {}),
    }),
  })
  const prediction = await response.json() as Prediction

  const initialStatus = prediction.status === "succeeded" ? "processing" : mapStatus(prediction.status)
  await env.DB.prepare("UPDATE turns SET replicate_prediction_id = ?, status = ? WHERE id = ?")
    .bind(prediction.id, initialStatus, turn.id)
    .run()
  await recordGenerationEvent(env, turn.id, "status", { status: initialStatus })
  if (prediction.status === "succeeded") {
    await reconcileTurn(env, turn.id, prediction)
  }
  return prediction
}

export async function reconcileTurn(env: Env, turnId: string, suppliedPrediction?: Prediction) {
  let turn = await findTurn(env, turnId)
  if (isTerminal(turn.status)) {
    return turn
  }
  if (!turn.replicate_prediction_id) {
    return turn
  }

  const prediction = suppliedPrediction ?? (await getPrediction(env, turn.replicate_prediction_id))
  if (prediction.id !== turn.replicate_prediction_id) {
    throw new ApiError(409, "PREDICTION_MISMATCH", "Replicate prediction does not match this generation.")
  }

  if (prediction.status === "failed" || prediction.status === "canceled" || prediction.status === "aborted") {
    const status: TurnStatus = prediction.status === "failed" ? "failed" : "canceled"
    const message = prediction.status === "failed" ? String(prediction.error ?? "Generation failed.") : null
    await env.DB.prepare("UPDATE turns SET status = ?, error_message = ?, completed_at = ? WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'canceled')")
      .bind(status, message, now(), turn.id)
      .run()
    await recordGenerationEvent(env, turn.id, status, { status, message })
    return findTurn(env, turn.id)
  }

  if (prediction.status !== "succeeded") {
    const status = mapStatus(prediction.status)
    if (status !== turn.status) {
      await env.DB.prepare("UPDATE turns SET status = ? WHERE id = ? AND status NOT IN ('persisting', 'succeeded', 'failed', 'canceled')")
        .bind(status, turn.id)
        .run()
      await recordGenerationEvent(env, turn.id, "status", { status })
    }
    return findTurn(env, turn.id)
  }

  const claimed = await env.DB.prepare("UPDATE turns SET status = 'persisting' WHERE id = ? AND status NOT IN ('succeeded', 'failed', 'canceled')")
    .bind(turn.id)
    .run()
  if (claimed.meta.changes === 0) {
    return findTurn(env, turn.id)
  }
  await recordGenerationEvent(env, turn.id, "status", { status: "persisting" })

  try {
    const outputUrl = firstOutputUrl(prediction.output)
    const response = await fetch(outputUrl, { headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` } })
    const assetId = await storeGeneratedOutput(env, turn.id, turn.conversation_id, response, turn.model === GROK_IMAGE_MODEL)
    await env.DB.prepare("UPDATE turns SET status = 'succeeded', output_asset_id = ?, completed_at = ?, error_message = NULL WHERE id = ?")
      .bind(assetId, now(), turn.id)
      .run()
    await recordGenerationEvent(env, turn.id, "completed", { status: "succeeded", assetId })
  } catch (error) {
    await env.DB.prepare("UPDATE turns SET status = 'processing', error_message = ? WHERE id = ? AND status = 'persisting'")
      .bind("Output persistence failed and will be retried.", turn.id)
      .run()
    throw error
  }

  turn = await findTurn(env, turn.id)
  return turn
}

export async function cancelTurn(env: Env, turnId: string) {
  const turn = await findTurn(env, turnId)
  if (isTerminal(turn.status)) {
    return turn
  }
  if (turn.replicate_prediction_id) {
    await cancelPrediction(env, turn.replicate_prediction_id)
  }
  await env.DB.prepare("UPDATE turns SET status = 'canceled', completed_at = ? WHERE id = ?")
    .bind(now(), turnId)
    .run()
  await recordGenerationEvent(env, turnId, "canceled", { status: "canceled" })
  return findTurn(env, turnId)
}

function mapStatus(status: Prediction["status"]): TurnStatus {
  if (status === "starting") {
    return "starting"
  }
  if (status === "processing") {
    return "processing"
  }
  if (status === "succeeded") {
    return "succeeded"
  }
  if (status === "failed") {
    return "failed"
  }
  return "canceled"
}

export function isTerminal(status: TurnStatus) {
  return status === "succeeded" || status === "failed" || status === "canceled"
}

function firstOutputUrl(output: unknown) {
  const candidate = Array.isArray(output) ? output[0] : output
  if (typeof candidate !== "string") {
    throw new ApiError(502, "INVALID_MODEL_OUTPUT", "Replicate did not return an image output URL.")
  }
  return candidate
}
