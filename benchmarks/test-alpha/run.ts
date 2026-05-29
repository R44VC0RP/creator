import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Prediction = {
  id: string
  model?: string
  status: string
  outputs?: string[]
  error?: string
}

type Result = {
  label: string
  model: string
  endpoint: string
  input: Record<string, unknown>
  status: "succeeded" | "failed"
  predictionId?: string
  outputUrl?: string
  outputFile?: string
  elapsedMs: number
  error?: string
}

const directory = dirname(fileURLToPath(import.meta.url))
const referencePath = join(directory, "base.jpeg")
const baseUrl = "https://api.wavespeed.ai/api/v3"
const token = process.env.WAVESPEED_API_KEY
const prompt =
  "The man in the reference image starts dancing around playfully in his room, doing upbeat side steps and arm movements while keeping his face, clothing, and room recognizable. Natural handheld camera feel, realistic motion, joyful energy."

if (!token) throw new Error("WAVESPEED_API_KEY is required.")

async function json<T>(response: Response, label: string) {
  if (!response.ok) {
    throw new Error(
      `${label} failed (${response.status}): ${await response.text()}`
    )
  }
  return response.json() as Promise<T>
}

async function uploadReference() {
  const form = new FormData()
  form.append("file", Bun.file(referencePath), "base.jpeg")
  const payload = await json<{ data?: { download_url?: string } }>(
    await fetch(`${baseUrl}/media/upload/binary`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }),
    "Reference upload"
  )
  const url = payload.data?.download_url
  if (!url) throw new Error("Reference upload did not return a download URL.")
  return url
}

async function poll(id: string, label: string) {
  for (;;) {
    const payload = await json<{ data?: Prediction }>(
      await fetch(`${baseUrl}/predictions/${encodeURIComponent(id)}/result`, {
        headers: { Authorization: `Bearer ${token}` },
      }),
      `${label} poll`
    )
    const prediction = payload.data
    if (!prediction) throw new Error(`${label} poll returned no prediction.`)
    if (prediction.status === "completed") return prediction
    if (prediction.status === "failed") {
      throw new Error(prediction.error || `${label} generation failed.`)
    }
    await Bun.sleep(2_000)
  }
}

async function run(
  label: string,
  model: string,
  input: Record<string, unknown>,
  outputFile: string,
  existingPredictionId?: string
): Promise<Result> {
  const endpoint = `/${model}`
  const started = performance.now()
  try {
    const submitted = existingPredictionId
      ? null
      : await json<{ data?: Prediction }>(
          await fetch(`${baseUrl}${endpoint}`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(input),
          }),
          `${label} submission`
        )
    const predictionId = existingPredictionId ?? submitted?.data?.id
    if (!predictionId) throw new Error(`${label} returned no prediction ID.`)
    if (existingPredictionId) console.log(`${label}: resuming ${predictionId}`)
    else console.log(`${label}: submitted ${predictionId}`)
    const prediction =
      submitted?.data?.status === "completed"
        ? submitted.data
        : await poll(predictionId, label)
    const outputUrl = prediction.outputs?.[0]
    if (!outputUrl) throw new Error(`${label} returned no output video URL.`)
    const response = await fetch(outputUrl)
    if (!response.ok)
      throw new Error(`${label} video download failed (${response.status}).`)
    await Bun.write(join(directory, outputFile), await response.arrayBuffer())
    return {
      label,
      model,
      endpoint,
      input,
      status: "succeeded",
      predictionId: prediction.id,
      outputUrl,
      outputFile,
      elapsedMs: Math.round(performance.now() - started),
    }
  } catch (error) {
    return {
      label,
      model,
      endpoint,
      input,
      status: "failed",
      elapsedMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const referenceUrl = await uploadReference()
const shared = {
  prompt,
  aspect_ratio: "16:9",
  resolution: "720p",
  duration: 10,
  enable_web_search: false,
  generate_audio: true,
}
const results = await Promise.all([
  run(
    "Seedance 2.0 Image-to-Video Turbo",
    "bytedance/seedance-2.0/image-to-video-turbo",
    { ...shared, image: "Original WaveSpeed upload of base.jpeg" },
    "image-to-video-turbo.mp4",
    "bf1c7f5ebdf6463f9c38ff3e714613ae"
  ),
  run(
    "Seedance 2.0 Fast Text-to-Video Turbo with reference image",
    "bytedance/seedance-2.0-fast/text-to-video-turbo",
    { ...shared, reference_images: [referenceUrl] },
    "text-to-video-turbo.mp4"
  ),
])

await writeFile(
  join(directory, "results.json"),
  `${JSON.stringify({ prompt, referenceFile: "base.jpeg", referenceUrl, results }, null, 2)}\n`,
  "utf8"
)

for (const result of results) {
  const seconds = (result.elapsedMs / 1_000).toFixed(2)
  console.log(
    `${result.label}: ${result.status} in ${seconds}s${result.error ? ` - ${result.error}` : ""}`
  )
}

if (results.some((result) => result.status === "failed")) process.exitCode = 1
