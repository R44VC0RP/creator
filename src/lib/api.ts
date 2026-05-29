export type Person = {
  id: string
  name: string
  handle: string
  colorToken: string
  imageSrc: string
}

export type ImageModel = "openai/gpt-image-2" | "xai/grok-imagine-image-quality"
export type VideoModel =
  | "bytedance/seedance-2.0"
  | "bytedance/seedance-2.0/image-to-video-turbo"
  | "bytedance/seedance-2.0/text-to-video"
  | "kwaivgi/kling-video-o3-pro/image-to-video"
  | "xai/grok-imagine-video"
export type GenerationModel = ImageModel | VideoModel
export type GenerationMode = "image" | "video"
export type GenerationProvider = "replicate" | "wavespeed"

export type ConversationSummary = {
  id: string
  title: string
  titleStatus: "fallback" | "generating" | "generated" | "failed"
  previewSrc: string | null
  createdAt: string
  updatedAt: string
}

export type TurnInput = {
  assetId: string
  personId: string | null
  role: "edit_base" | "person_reference" | "attached_reference"
  ordinal: number
  src: string | null
  person: {
    id: string
    name: string
    handle: string
    colorToken: string
  } | null
}

export type Turn = {
  id: string
  conversationId: string
  parentTurnId: string | null
  kind: "generation" | "modification" | "regeneration"
  prompt: string
  model: GenerationModel
  provider: GenerationProvider
  mode: GenerationMode
  aspectRatio: string
  quality: "low" | "medium" | "high" | null
  resolution: "1k" | "2k" | "4k" | null
  videoResolution: "480p" | "720p" | "1080p" | null
  duration: number | null
  generateAudio: boolean | null
  status:
    | "queued"
    | "starting"
    | "processing"
    | "persisting"
    | "succeeded"
    | "failed"
    | "canceled"
  outputAssetId: string | null
  previewSrc: string | null
  downloadSrc: string | null
  contentSrc: string | null
  errorMessage: string | null
  createdAt: string
  inputs: TurnInput[]
  isSnapshot: boolean
  isForkPoint: boolean
}

export type Conversation = ConversationSummary & {
  turns: Turn[]
}

export type GalleryItem = {
  assetId: string
  turnId: string
  conversationId: string | null
  conversationTitle: string | null
  conversationDeleted: boolean
  prompt: string
  model: GenerationModel
  mode: GenerationMode
  aspectRatio: string
  quality: string | null
  resolution: string | null
  videoResolution: string | null
  duration: number | null
  generateAudio: boolean | null
  createdAt: string
  thumbnailSrc: string
  previewSrc: string
  contentSrc: string
  downloadSrc: string
  mayDelete: boolean
  mayFork: boolean
}

export type GenerationDraft = {
  prompt: string
  mode?: GenerationMode
  model: GenerationModel
  aspectRatio: string
  quality?: string
  resolution?: string
  videoResolution?: "480p" | "720p" | "1080p"
  duration?: number
  generateAudio?: boolean
  people: Person[]
  attachments: File[]
  conversationId?: string
  parentTurnId?: string
}

type ApiErrorPayload = { error?: { code?: string; message?: string } }

export class RequestError extends Error {
  readonly code: string
  readonly status: number

  constructor(code: string, message: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit) {
  const response = await fetch(path, init)
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as ApiErrorPayload
    throw new RequestError(
      payload.error?.code ?? "REQUEST_FAILED",
      payload.error?.message ?? "Request failed.",
      response.status
    )
  }
  if (response.status === 204) {
    return undefined as T
  }
  return response.json() as Promise<T>
}

type ServerPerson = {
  id: string
  name: string
  handle: string
  color_token: string
  imageSrc: string
}

type ServerConversation = {
  id: string
  title: string
  title_status: ConversationSummary["titleStatus"]
  previewSrc?: string | null
  created_at: string
  updated_at: string
}

type ServerTurn = {
  id: string
  conversation_id: string
  parent_turn_id: string | null
  kind: Turn["kind"]
  authored_prompt: string
  model: GenerationModel
  provider: GenerationProvider
  generation_mode: GenerationMode
  aspect_ratio: string
  quality: Turn["quality"]
  resolution: Turn["resolution"]
  video_resolution: Turn["videoResolution"]
  video_duration: number | null
  generate_audio: boolean | number | null
  status: Turn["status"]
  output_asset_id: string | null
  previewSrc: string | null
  downloadSrc: string | null
  contentSrc: string | null
  error_message: string | null
  created_at: string
  inputs?: TurnInput[]
  isSnapshot?: boolean
  isForkPoint?: boolean
}

function person(value: ServerPerson): Person {
  return {
    id: value.id,
    name: value.name,
    handle: value.handle,
    colorToken: value.color_token,
    imageSrc: value.imageSrc,
  }
}

function conversationSummary(value: ServerConversation): ConversationSummary {
  return {
    id: value.id,
    title: value.title,
    titleStatus: value.title_status,
    previewSrc: value.previewSrc ?? null,
    createdAt: value.created_at,
    updatedAt: value.updated_at,
  }
}

export function turn(value: ServerTurn): Turn {
  return {
    id: value.id,
    conversationId: value.conversation_id,
    parentTurnId: value.parent_turn_id,
    kind: value.kind,
    prompt: value.authored_prompt,
    model: value.model,
    provider: value.provider,
    mode: value.generation_mode,
    aspectRatio: value.aspect_ratio,
    quality: value.quality,
    resolution: value.resolution,
    videoResolution: value.video_resolution,
    duration: value.video_duration,
    generateAudio:
      value.generate_audio === null ? null : Boolean(value.generate_audio),
    status: value.status,
    outputAssetId: value.output_asset_id,
    previewSrc: value.previewSrc,
    downloadSrc: value.downloadSrc,
    contentSrc: value.contentSrc,
    errorMessage: value.error_message,
    createdAt: value.created_at,
    inputs: value.inputs ?? [],
    isSnapshot: value.isSnapshot ?? false,
    isForkPoint: value.isForkPoint ?? false,
  }
}

export async function listPeople() {
  const data = await request<{ people: ServerPerson[] }>("/api/people")
  return data.people.map(person)
}

export async function addPerson(formData: FormData) {
  const data = await request<{ person: ServerPerson }>("/api/people", {
    method: "POST",
    body: formData,
  })
  return person(data.person)
}

export async function deletePerson(personId: string) {
  return request<void>(`/api/people/${personId}`, { method: "DELETE" })
}

export async function listConversations() {
  const data = await request<{ conversations: ServerConversation[] }>(
    "/api/conversations"
  )
  return data.conversations.map(conversationSummary)
}

export async function getConversation(id: string) {
  const data = await request<{
    conversation: ServerConversation
    turns: ServerTurn[]
  }>(`/api/conversations/${id}`)
  return {
    ...conversationSummary(data.conversation),
    turns: data.turns.map(turn),
  }
}

export async function deleteConversation(conversationId: string) {
  return request<void>(`/api/conversations/${conversationId}`, {
    method: "DELETE",
  })
}

export async function createGeneration(draft: GenerationDraft) {
  const body = new FormData()
  body.set("prompt", draft.prompt)
  body.set("mode", draft.mode ?? "image")
  body.set("model", draft.model)
  body.set("aspectRatio", draft.aspectRatio)
  if (draft.mode === "video") {
    if (draft.model !== "kwaivgi/kling-video-o3-pro/image-to-video")
      body.set("videoResolution", draft.videoResolution ?? "720p")
    body.set("duration", String(draft.duration ?? 5))
    if (
      draft.model === "bytedance/seedance-2.0/text-to-video" ||
      draft.model === "kwaivgi/kling-video-o3-pro/image-to-video"
    )
      body.set("generateAudio", String(draft.generateAudio !== false))
  } else if (draft.model === "openai/gpt-image-2") {
    body.set("quality", draft.quality ?? "medium")
  }
  draft.people.forEach((item) => body.append("personIds", item.id))
  draft.attachments.forEach((file) => body.append("attachments", file))
  if (draft.conversationId && draft.parentTurnId) {
    body.set("conversationId", draft.conversationId)
    body.set("parentTurnId", draft.parentTurnId)
  }
  const data = await request<{
    conversation: ServerConversation
    turn: ServerTurn
  }>("/api/generations", { method: "POST", body })
  return {
    conversation: conversationSummary(data.conversation),
    turn: turn(data.turn),
  }
}

export async function cancelGeneration(turnId: string) {
  const data = await request<{ turn: ServerTurn }>(
    `/api/generations/${turnId}/cancel`,
    { method: "POST" }
  )
  return turn(data.turn)
}

export async function regenerateGeneration(
  turnId: string,
  conversationId: string
) {
  const data = await request<{ turn: ServerTurn }>(
    `/api/generations/${turnId}/regenerate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ conversationId }),
    }
  )
  return turn(data.turn)
}

export async function reviseTurn(
  turnId: string,
  conversationId: string,
  prompt: string
) {
  const data = await request<{
    conversation: ServerConversation
    turn: ServerTurn
  }>(`/api/turns/${turnId}/revise`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ conversationId, prompt }),
  })
  return {
    conversation: conversationSummary(data.conversation),
    turn: turn(data.turn),
  }
}

export async function forkTurn(turnId: string) {
  const data = await request<{
    conversation: ServerConversation
    focusedTurn: ServerTurn
  }>(`/api/turns/${turnId}/fork`, { method: "POST" })
  return {
    conversation: conversationSummary(data.conversation),
    focusedTurn: turn(data.focusedTurn),
  }
}

export async function listGallery() {
  const data = await request<{ gallery: GalleryItem[] }>("/api/gallery")
  return data.gallery
}

export async function getGalleryItem(assetId: string) {
  const data = await request<{ item: GalleryItem }>(`/api/gallery/${assetId}`)
  return data.item
}

export async function deleteGalleryItem(assetId: string) {
  return request<void>(`/api/gallery/${assetId}`, { method: "DELETE" })
}
