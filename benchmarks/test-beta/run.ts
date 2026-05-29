import { writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

type Prediction = {
  id: string
  status: string
  outputs?: string[]
  error?: string
}

type Result = {
  label: string
  model: string
  input: Record<string, unknown>
  status: "succeeded" | "failed"
  predictionId?: string
  outputUrl?: string
  outputFile?: string
  elapsedMs: number
  error?: string
}

const directory = dirname(fileURLToPath(import.meta.url))
const referencePath = join(directory, "../test-alpha/base.jpeg")
const baseUrl = "https://api.wavespeed.ai/api/v3"
const token = process.env.WAVESPEED_API_KEY
const referencePrompt =
  "The man in the reference image starts dancing around playfully in his room, doing upbeat side steps and arm movements while keeping his face, black OPENCODE graphic T-shirt, and room recognizable. Natural handheld camera feel, realistic motion, joyful energy."
const textOnlyPrompt =
  "A realistic young man in a black OPENCODE graphic T-shirt dances around playfully in a creative bedroom studio, doing upbeat side steps and arm movements. Natural handheld camera feel, cinematic indoor lighting, realistic motion, joyful energy."

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
  outputFile: string
): Promise<Result> {
  const started = performance.now()
  try {
    const payload = await json<{ data?: Prediction }>(
      await fetch(`${baseUrl}/${model}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      }),
      `${label} submission`
    )
    if (!payload.data?.id)
      throw new Error(`${label} returned no prediction ID.`)
    console.log(`${label}: submitted ${payload.data.id}`)
    const prediction =
      payload.data.status === "completed"
        ? payload.data
        : await poll(payload.data.id, label)
    const outputUrl = prediction.outputs?.[0]
    if (!outputUrl) throw new Error(`${label} returned no output video URL.`)
    const response = await fetch(outputUrl)
    if (!response.ok)
      throw new Error(`${label} video download failed (${response.status}).`)
    await Bun.write(join(directory, outputFile), await response.arrayBuffer())
    return {
      label,
      model,
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
      input,
      status: "failed",
      elapsedMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

const referenceUrl = await uploadReference()
const results = await Promise.all([
  run(
    "Kling Video O3 Pro Image-to-Video",
    "kwaivgi/kling-video-o3-pro/image-to-video",
    {
      prompt: referencePrompt,
      image: referenceUrl,
      duration: 10,
      sound: true,
    },
    "kling-video-o3-pro-image-to-video.mp4"
  ),
  run(
    "Kling Video O3 Pro Reference-to-Video",
    "kwaivgi/kling-video-o3-pro/reference-to-video",
    {
      prompt: referencePrompt,
      images: [referenceUrl],
      aspect_ratio: "16:9",
      duration: 10,
      sound: true,
    },
    "kling-video-o3-pro-reference-to-video.mp4"
  ),
  run(
    "Kling Video O3 4K Text-to-Video",
    "kwaivgi/kling-video-o3-4k/text-to-video",
    {
      prompt: textOnlyPrompt,
      aspect_ratio: "16:9",
      duration: 10,
      sound: true,
    },
    "kling-video-o3-4k-text-to-video.mp4"
  ),
])

await writeFile(
  join(directory, "results.json"),
  `${JSON.stringify({ referenceFile: "../test-alpha/base.jpeg", referenceUrl, referencePrompt, textOnlyPrompt, results }, null, 2)}\n`,
  "utf8"
)

for (const result of results) {
  const seconds = (result.elapsedMs / 1_000).toFixed(2)
  console.log(
    `${result.label}: ${result.status} in ${seconds}s${result.error ? ` - ${result.error}` : ""}`
  )
}

if (results.some((result) => result.status === "failed")) process.exitCode = 1
