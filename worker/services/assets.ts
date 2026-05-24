import type { AssetKind, AssetRow, Env } from "../types"
import { ApiError } from "../lib/errors"
import { id, now } from "../lib/values"

const ACCEPTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/avif"])
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024

type NormalizedImageOptions = {
  kind: "person_reference" | "turn_reference"
  prefix: string
  maxDimension: number
  quality: number
}

export async function getAsset(env: Env, assetId: string) {
  const asset = await env.DB.prepare("SELECT * FROM assets WHERE id = ?").bind(assetId).first<AssetRow>()
  if (!asset || asset.deleted_at || !asset.r2_key) {
    throw new ApiError(404, "ASSET_NOT_FOUND", "The requested asset does not exist.")
  }
  return asset
}

export async function normalizeAndStoreImage(env: Env, file: File, options: NormalizedImageOptions) {
  if (!ACCEPTED_IMAGE_TYPES.has(file.type)) {
    throw new ApiError(422, "INVALID_IMAGE", "Only JPEG, PNG, WebP, or AVIF images are supported.")
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, "UPLOAD_TOO_LARGE", "Images must be 10 MB or smaller.")
  }

  let info: ImageInfoResponse
  try {
    info = await env.IMAGES.info(file.stream())
  } catch {
    throw new ApiError(422, "INVALID_IMAGE", "The uploaded file could not be decoded as an image.")
  }

  const result = await env.IMAGES.input(file.stream())
    .transform({ fit: "scale-down", width: options.maxDimension, height: options.maxDimension })
    .output({ format: "image/webp", quality: options.quality, anim: false })
  const response = result.response()
  const bytes = await response.arrayBuffer()
  const assetId = id()
  const r2Key = `${options.prefix}/${assetId}.webp`
  const createdAt = now()

  await env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: "image/webp" } })
  try {
    await env.DB.prepare(
      "INSERT INTO assets (id, kind, r2_key, mime_type, byte_size, width, height, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
      .bind(
        assetId,
        options.kind,
        r2Key,
        "image/webp",
        bytes.byteLength,
        "width" in info ? info.width : null,
        "height" in info ? info.height : null,
        createdAt
      )
      .run()
  } catch (error) {
    await env.MEDIA.delete(r2Key)
    throw error
  }

  return { id: assetId, kind: options.kind, mimeType: "image/webp", r2Key, createdAt }
}

export async function storeGeneratedOutput(env: Env, turnId: string, conversationId: string, response: Response, normalizeToPng = false) {
  if (!response.ok || !response.body) {
    throw new ApiError(502, "OUTPUT_DOWNLOAD_FAILED", "Replicate output could not be downloaded.")
  }

  const imageResponse = normalizeToPng
    ? (await env.IMAGES.input(response.body).output({ format: "image/png", anim: false })).response()
    : response
  const bytes = await imageResponse.arrayBuffer()
  const assetId = `output-${turnId}`
  const r2Key = `generations/${conversationId}/${turnId}/${assetId}.png`
  const createdAt = now()

  await env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: "image/png" } })
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO assets (id, kind, r2_key, mime_type, byte_size, created_at) VALUES (?, 'generation_output', ?, 'image/png', ?, ?)"
    )
      .bind(assetId, r2Key, bytes.byteLength, createdAt)
      .run()
  } catch (error) {
    await env.MEDIA.delete(r2Key)
    throw error
  }

  return assetId
}

export async function storeGeneratedVideo(env: Env, turnId: string, conversationId: string, response: Response, sourceAssetId: string) {
  if (!response.ok || !response.body) {
    throw new ApiError(502, "OUTPUT_DOWNLOAD_FAILED", "Replicate video output could not be downloaded.")
  }

  const bytes = await response.arrayBuffer()
  const assetId = `output-${turnId}`
  const r2Key = `generations/${conversationId}/${turnId}/${assetId}.mp4`
  const createdAt = now()

  await env.MEDIA.put(r2Key, bytes, { httpMetadata: { contentType: "video/mp4" } })
  try {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO assets (id, kind, r2_key, mime_type, byte_size, source_asset_id, created_at) VALUES (?, 'generation_output', ?, 'video/mp4', ?, ?, ?)"
    ).bind(assetId, r2Key, bytes.byteLength, sourceAssetId, createdAt).run()
  } catch (error) {
    await env.MEDIA.delete(r2Key)
    throw error
  }
  return assetId
}

export async function assetBlob(env: Env, assetId: string) {
  const asset = await getAsset(env, assetId)
  const object = await env.MEDIA.get(asset.r2_key!)
  if (!object) {
    throw new ApiError(404, "ASSET_CONTENT_MISSING", "Asset content is no longer available.")
  }
  return new Blob([await object.arrayBuffer()], { type: asset.mime_type })
}

export async function serveAsset(env: Env, asset: AssetRow, variant: string | null, download: boolean) {
  const object = await env.MEDIA.get(asset.r2_key!)
  if (!object || !object.body) {
    throw new ApiError(404, "ASSET_CONTENT_MISSING", "Asset content is no longer available.")
  }

  const headers = new Headers()
  headers.set("Cache-Control", download ? "private, max-age=0" : "private, max-age=3600")
  const extension = asset.mime_type === "video/mp4" ? "mp4" : asset.mime_type === "image/png" ? "png" : "webp"
  headers.set("Content-Disposition", download ? `attachment; filename="${asset.id}.${extension}"` : "inline")

  if (asset.mime_type === "video/mp4") {
    if (variant) throw new ApiError(400, "INVALID_ASSET_VARIANT", "Video assets cannot be transformed as images.")
    headers.set("Content-Type", asset.mime_type)
    return new Response(object.body, { headers })
  }

  if (!variant) {
    headers.set("Content-Type", asset.mime_type)
    return new Response(object.body, { headers })
  }

  const transform = variant === "thumbnail" ? { width: 384, height: 384 } : { width: 1400, height: 1400 }
  const transformed = await env.IMAGES.input(object.body)
    .transform({ ...transform, fit: "scale-down" })
    .output({ format: "image/webp", quality: variant === "thumbnail" ? 78 : 88, anim: false })
  headers.set("Content-Type", "image/webp")
  return new Response(transformed.response().body, { headers })
}

export function assetUrl(assetId: string, variant?: "thumbnail" | "preview") {
  return `/api/assets/${assetId}/content${variant ? `?variant=${variant}` : ""}`
}

export function downloadableAssetUrl(assetId: string) {
  return `/api/assets/${assetId}/content?download=1`
}

export async function markAssetDeleted(env: Env, asset: AssetRow) {
  if (asset.r2_key) {
    await env.MEDIA.delete(asset.r2_key)
  }
  await env.DB.prepare("UPDATE assets SET deleted_at = ?, r2_key = NULL WHERE id = ? AND deleted_at IS NULL")
    .bind(now(), asset.id)
    .run()
}

export type StoredAssetKind = AssetKind
