export type Env = {
  ASSETS: Fetcher
  DB: D1Database
  MEDIA: R2Bucket
  IMAGES: ImagesBinding
  REPLICATE_API_TOKEN: string
  WAVESPEED_API_KEY: string
  OPENCODE_ZEN_API_KEY: string
  REPLICATE_WEBHOOK_SIGNING_SECRET?: string
  PUBLIC_APP_URL?: string
}

export type AssetKind =
  | "person_reference"
  | "turn_reference"
  | "generation_output"
export type InputRole = "edit_base" | "person_reference" | "attached_reference"
export type TurnKind = "generation" | "modification" | "regeneration"
export type ImageModel = "openai/gpt-image-2" | "xai/grok-imagine-image-quality"
export type VideoModel =
  | "bytedance/seedance-2.0"
  | "bytedance/seedance-2.0/image-to-video-turbo"
  | "bytedance/seedance-2.0/text-to-video"
  | "kwaivgi/kling-video-o3-pro/image-to-video"
  | "xai/grok-imagine-video"
export type GenerationModel = ImageModel | VideoModel
export type GenerationMode = "image" | "video"
export type TurnStatus =
  | "queued"
  | "starting"
  | "processing"
  | "persisting"
  | "succeeded"
  | "failed"
  | "canceled"
export type GenerationProvider = "replicate" | "wavespeed"

export type AssetRow = {
  id: string
  kind: AssetKind
  r2_key: string | null
  mime_type: string
  byte_size: number | null
  width: number | null
  height: number | null
  sha256: string | null
  source_asset_id: string | null
  deleted_at: string | null
  created_at: string
}

export type PersonRow = {
  id: string
  name: string
  handle: string
  color_token: string
  reference_asset_id: string
  archived_at: string | null
  created_at: string
  updated_at: string
}

export type ConversationRow = {
  id: string
  title: string
  title_status: "fallback" | "generating" | "generated" | "failed"
  forked_from_conversation_id: string | null
  forked_from_turn_id: string | null
  deleted_at: string | null
  created_at: string
  updated_at: string
}

export type TurnRow = {
  id: string
  conversation_id: string
  parent_turn_id: string | null
  kind: TurnKind
  authored_prompt: string
  compiled_prompt: string
  model: GenerationModel
  provider: GenerationProvider
  generation_mode: GenerationMode
  aspect_ratio: string
  quality: "low" | "medium" | "high"
  resolution: "1k" | "2k" | null
  video_resolution: "480p" | "720p" | "1080p" | null
  delivery_resolution: "480p" | "720p" | "1080p" | null
  video_duration: number | null
  generate_audio: 0 | 1 | null
  output_format: "png" | "mp4"
  status: TurnStatus
  replicate_prediction_id: string | null
  output_asset_id: string | null
  error_message: string | null
  created_at: string
  completed_at: string | null
}

export type TurnInputRow = {
  turn_id: string
  asset_id: string
  person_id: string | null
  role: InputRole
  ordinal: number
  r2_key: string | null
  mime_type: string
  deleted_at: string | null
}

export type AppVariables = {
  turn?: TurnRow
}
