import { ApiError } from "./errors"

import type { ImageModel } from "../types"

export const DEFAULT_IMAGE_MODEL: ImageModel = "openai/gpt-image-2"
export const GROK_IMAGE_MODEL: ImageModel = "xai/grok-imagine-image-quality"
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
  return value.trim().toLowerCase().replace(/[^a-z0-9-]/g, "")
}

export function cleanPrompt(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "INVALID_PROMPT", "A prompt is required.")
  }

  return value.trim()
}

export function parseAspectRatio(value: FormDataEntryValue | null): "1:1" | "3:2" | "2:3" {
  if (value === null || value === "") {
    return "3:2"
  }
  if (value !== "1:1" && value !== "3:2" && value !== "2:3") {
    throw new ApiError(400, "INVALID_ASPECT_RATIO", "Unsupported aspect ratio.")
  }
  return value
}

export function parseQuality(value: FormDataEntryValue | null): "low" | "medium" | "high" {
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
  if (value !== DEFAULT_IMAGE_MODEL && value !== GROK_IMAGE_MODEL) {
    throw new ApiError(400, "INVALID_MODEL", "Unsupported image model.")
  }
  return value
}

export function parseResolution(value: FormDataEntryValue | null): "1k" | "2k" {
  if (value === null || value === "") {
    return "2k"
  }
  if (value !== "1k" && value !== "2k") {
    throw new ApiError(400, "INVALID_RESOLUTION", "Unsupported Grok resolution.")
  }
  return value
}

export function temporaryTitle(prompt: string) {
  const value = prompt.replace(/\s+/g, " ").trim()
  return value.length > 46 ? `${value.slice(0, 45).trim()}...` : value
}

export function stringValue(value: FormDataEntryValue | null) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}
