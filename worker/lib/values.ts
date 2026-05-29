import { ApiError } from "./errors"

import type { GenerationMode, ImageModel, VideoModel } from "../types"

export const DEFAULT_IMAGE_MODEL: ImageModel = "openai/gpt-image-2"
export const GROK_IMAGE_MODEL: ImageModel = "xai/grok-imagine-image-quality"
export const LEGACY_REPLICATE_SEEDANCE_MODEL: VideoModel =
  "bytedance/seedance-2.0"
export const DEFAULT_VIDEO_MODEL: VideoModel =
  "bytedance/seedance-2.0/image-to-video-turbo"
export const GROK_VIDEO_MODEL: VideoModel = "xai/grok-imagine-video"
export const MAX_PEOPLE_PER_TURN = 4
export const MAX_ATTACHMENTS_PER_TURN = 2
export const PERSON_COLOR_TOKENS = [
  "bg-cyan-400/15 text-cyan-300 ring-cyan-400/30",
  "bg-violet-400/15 text-violet-300 ring-violet-400/30",
  "bg-rose-400/15 text-rose-300 ring-rose-400/30",
  "bg-amber-400/15 text-amber-300 ring-amber-400/30",
  "bg-emerald-400/15 text-emerald-300 ring-emerald-400/30",
  "bg-orange-400/15 text-orange-300 ring-orange-400/30",
] as const

export function now() {
  return new Date().toISOString()
}

export function id() {
  return crypto.randomUUID()
}

export function cleanHandle(value: string) {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "")
}

export function cleanPrompt(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "INVALID_PROMPT", "A prompt is required.")
  }

  return value.trim()
}

export function parseAspectRatio(
  value: FormDataEntryValue | null
): "1:1" | "3:2" | "2:3" | "16:9" {
  if (value === null || value === "") {
    return "3:2"
  }
  if (
    value !== "1:1" &&
    value !== "3:2" &&
    value !== "2:3" &&
    value !== "16:9"
  ) {
    throw new ApiError(400, "INVALID_ASPECT_RATIO", "Unsupported aspect ratio.")
  }
  return value
}

export function parseQuality(
  value: FormDataEntryValue | null
): "low" | "medium" | "high" {
  if (value === null || value === "") {
    return "medium"
  }
  if (value !== "low" && value !== "medium" && value !== "high") {
    throw new ApiError(400, "INVALID_QUALITY", "Unsupported quality setting.")
  }
  return value
}

export function parseImageModel(value: FormDataEntryValue | null): ImageModel {
  if (value === null || value === "") {
    return DEFAULT_IMAGE_MODEL
  }
  if (value !== DEFAULT_IMAGE_MODEL) {
    throw new ApiError(
      400,
      "INVALID_MODEL",
      "GPT is the only available image model."
    )
  }
  return value
}

export function parseGenerationMode(
  value: FormDataEntryValue | null
): GenerationMode {
  if (value === null || value === "") return "image"
  if (value !== "image" && value !== "video") {
    throw new ApiError(400, "INVALID_MODE", "Unsupported generation mode.")
  }
  return value
}

export function parseVideoModel(value: FormDataEntryValue | null): VideoModel {
  if (value === null || value === "") return DEFAULT_VIDEO_MODEL
  if (value !== DEFAULT_VIDEO_MODEL && value !== GROK_VIDEO_MODEL) {
    throw new ApiError(400, "INVALID_MODEL", "Unsupported video model.")
  }
  return value
}

export function parseVideoResolution(
  value: FormDataEntryValue | null
): "480p" | "720p" | "1080p" {
  if (value === null || value === "") return "720p"
  if (value !== "480p" && value !== "720p" && value !== "1080p") {
    throw new ApiError(
      400,
      "INVALID_VIDEO_RESOLUTION",
      "Unsupported video resolution."
    )
  }
  return value
}

export function parseVideoDuration(value: FormDataEntryValue | null) {
  const duration = value === null || value === "" ? 5 : Number(value)
  if (!Number.isInteger(duration) || duration < 1 || duration > 15) {
    throw new ApiError(
      400,
      "INVALID_VIDEO_DURATION",
      "Video duration must be between 1 and 15 seconds."
    )
  }
  return duration
}

export function parseVideoAspectRatio(value: FormDataEntryValue | null) {
  const ratio = typeof value === "string" && value ? value : "16:9"
  const supported = [
    "16:9",
    "9:16",
    "4:3",
    "3:4",
    "3:2",
    "2:3",
    "1:1",
    "21:9",
    "adaptive",
  ]
  if (!supported.includes(ratio)) {
    throw new ApiError(
      400,
      "INVALID_ASPECT_RATIO",
      "Unsupported video aspect ratio."
    )
  }
  return ratio
}

export function temporaryTitle(prompt: string) {
  const value = prompt.replace(/\s+/g, " ").trim()
  return value.length > 46 ? `${value.slice(0, 45).trim()}...` : value
}

export function stringValue(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
