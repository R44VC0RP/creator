import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

type Provider = "wavespeed" | "replicate"
type MediaKind = "image" | "video"
type JobStatus = "succeeded" | "failed" | "skipped"

type CompletedMedia = {
  url: string
  providerJobId: string
}

type BenchmarkJob = {
  name: string
  pipeline: "gpt-seedance" | "grok-grok-video"
  stage: MediaKind
  provider: Provider
  model: string
  prompt: string
  settings: Record<string, string | number | boolean>
  status: JobStatus
  startedAt: string
  completedAt: string
  elapsedMs: number
  providerJobId?: string
  outputUrl?: string
  error?: string
}

type PipelineSource = {
  pipeline: BenchmarkJob["pipeline"]
  index: number
  image: CompletedMedia
}

const RUNS = 3
const POLL_INTERVAL_MS = 1_000
const JOB_TIMEOUT_MS = 30 * 60 * 1_000
const WAVESPEED_BASE_URL = "https://api.wavespeed.ai/api/v3"
const REPLICATE_BASE_URL = "https://api.replicate.com/v1"

const IMAGE_PROMPTS = [
  "A documentary-style photograph of a cyclist stopped at a rainy neon intersection at blue hour, realistic reflections, 35mm lens, natural motion blur, cinematic composition.",
  "A sunlit coastal kitchen with an open window, linen curtains moving in the breeze, a ceramic coffee cup on a wooden table, realistic editorial photography, warm highlights.",
  "A portrait of an astronaut standing in a greenhouse on Mars, condensation on the glass, red dust beyond the windows, believable lighting, detailed photographic realism.",
] as const

const VIDEO_PROMPT =
  "Add subtle natural motion: a slow cinematic push-in, environmental movement appropriate to the scene, realistic lighting changes, stable subject details."

const waveSpeedToken = requireEnvironment("WAVESPEED_API_KEY")
const replicateToken = requireEnvironment("REPLICATE_API_TOKEN")

function requireEnvironment(name: string) {
  const value = process.env[name]
  if (!value) {
    throw new Error(
      `Missing ${name}. Set it in .env before running the benchmark.`
    )
  }
  return value
}

function elapsedSeconds(started: number) {
  return `${((performance.now() - started) / 1_000).toFixed(1)}s`
}

function formatDuration(milliseconds: number) {
  return `${(milliseconds / 1_000).toFixed(2)}s`
}

function delay(milliseconds: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, milliseconds))
}

function firstUrl(output: unknown) {
  const value = Array.isArray(output) ? output[0] : output
  if (typeof value === "string") return value
  if (
    value &&
    typeof value === "object" &&
    "url" in value &&
    typeof value.url === "string"
  )
    return value.url
  throw new Error("Provider completed without returning an output URL.")
}

async function responseJson<T>(response: Response, label: string) {
  if (!response.ok) {
    throw new Error(
      `${label} request failed (${response.status}): ${await response.text()}`
    )
  }
  return response.json() as Promise<T>
}

async function submitWaveSpeed(path: string, input: Record<string, unknown>) {
  const payload = await responseJson<{
    data?: { id: string; status: string; outputs?: string[]; error?: string }
    message?: string
  }>(
    await fetch(`${WAVESPEED_BASE_URL}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${waveSpeedToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(input),
    }),
    "WaveSpeed submission"
  )
  if (!payload.data?.id)
    throw new Error(
      payload.message || "WaveSpeed did not return a prediction id."
    )
  return payload.data
}

async function awaitWaveSpeed(
  id: string,
  label: string
): Promise<CompletedMedia> {
  const started = performance.now()
  let lastStatus = ""
  while (performance.now() - started < JOB_TIMEOUT_MS) {
    const payload = await responseJson<{
      data?: { id: string; status: string; outputs?: string[]; error?: string }
      message?: string
    }>(
      await fetch(
        `${WAVESPEED_BASE_URL}/predictions/${encodeURIComponent(id)}/result`,
        {
          headers: { Authorization: `Bearer ${waveSpeedToken}` },
        }
      ),
      "WaveSpeed polling"
    )
    if (!payload.data)
      throw new Error(
        payload.message || "WaveSpeed polling response was invalid."
      )
    if (payload.data.status !== lastStatus) {
      console.log(
        `  ${label}: ${payload.data.status} (${elapsedSeconds(started)})`
      )
      lastStatus = payload.data.status
    }
    if (payload.data.status === "completed")
      return { url: firstUrl(payload.data.outputs), providerJobId: id }
    if (payload.data.status === "failed")
      throw new Error(payload.data.error || "WaveSpeed prediction failed.")
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(
    `WaveSpeed job ${id} timed out after ${formatDuration(JOB_TIMEOUT_MS)}.`
  )
}

async function runWaveSpeed(
  path: string,
  input: Record<string, unknown>,
  label: string
) {
  const submitted = await submitWaveSpeed(path, input)
  console.log(`  ${label}: submitted ${submitted.id}`)
  if (submitted.status === "completed")
    return { url: firstUrl(submitted.outputs), providerJobId: submitted.id }
  if (submitted.status === "failed")
    throw new Error(submitted.error || "WaveSpeed prediction failed.")
  return awaitWaveSpeed(submitted.id, label)
}

async function submitReplicate(model: string, input: Record<string, unknown>) {
  return responseJson<{
    id: string
    status: string
    output?: unknown
    error?: unknown
  }>(
    await fetch(`${REPLICATE_BASE_URL}/models/${model}/predictions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${replicateToken}`,
        "Content-Type": "application/json",
        Prefer: "wait=1",
      },
      body: JSON.stringify({ input }),
    }),
    "Replicate submission"
  )
}

async function awaitReplicate(
  id: string,
  label: string
): Promise<CompletedMedia> {
  const started = performance.now()
  let lastStatus = ""
  while (performance.now() - started < JOB_TIMEOUT_MS) {
    const prediction = await responseJson<{
      id: string
      status: string
      output?: unknown
      error?: unknown
    }>(
      await fetch(
        `${REPLICATE_BASE_URL}/predictions/${encodeURIComponent(id)}`,
        {
          headers: { Authorization: `Bearer ${replicateToken}` },
        }
      ),
      "Replicate polling"
    )
    if (prediction.status !== lastStatus) {
      console.log(
        `  ${label}: ${prediction.status} (${elapsedSeconds(started)})`
      )
      lastStatus = prediction.status
    }
    if (prediction.status === "succeeded")
      return { url: firstUrl(prediction.output), providerJobId: id }
    if (["failed", "canceled", "aborted"].includes(prediction.status)) {
      throw new Error(
        typeof prediction.error === "string"
          ? prediction.error
          : `Replicate prediction ${prediction.status}.`
      )
    }
    await delay(POLL_INTERVAL_MS)
  }
  throw new Error(
    `Replicate job ${id} timed out after ${formatDuration(JOB_TIMEOUT_MS)}.`
  )
}

async function runReplicate(
  model: string,
  input: Record<string, unknown>,
  label: string
) {
  const submitted = await submitReplicate(model, input)
  console.log(`  ${label}: submitted ${submitted.id}`)
  if (submitted.status === "succeeded")
    return { url: firstUrl(submitted.output), providerJobId: submitted.id }
  if (["failed", "canceled", "aborted"].includes(submitted.status)) {
    throw new Error(
      typeof submitted.error === "string"
        ? submitted.error
        : `Replicate prediction ${submitted.status}.`
    )
  }
  return awaitReplicate(submitted.id, label)
}

async function timedJob(
  job: Omit<
    BenchmarkJob,
    | "status"
    | "startedAt"
    | "completedAt"
    | "elapsedMs"
    | "providerJobId"
    | "outputUrl"
    | "error"
  >,
  execute: () => Promise<CompletedMedia>
) {
  const startedAt = new Date().toISOString()
  const started = performance.now()
  console.log(`\n${job.name}`)
  try {
    const result = await execute()
    const completed: BenchmarkJob = {
      ...job,
      status: "succeeded",
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      providerJobId: result.providerJobId,
      outputUrl: result.url,
    }
    console.log(`  completed in ${formatDuration(completed.elapsedMs)}`)
    return { job: completed, result }
  } catch (error) {
    const failed: BenchmarkJob = {
      ...job,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      elapsedMs: Math.round(performance.now() - started),
      error: error instanceof Error ? error.message : String(error),
    }
    console.error(
      `  failed in ${formatDuration(failed.elapsedMs)}: ${failed.error}`
    )
    return { job: failed, result: null }
  }
}

function skippedVideo(
  name: string,
  pipeline: BenchmarkJob["pipeline"],
  provider: Provider,
  model: string,
  prompt: string,
  settings: BenchmarkJob["settings"]
) {
  const at = new Date().toISOString()
  return {
    name,
    pipeline,
    stage: "video" as const,
    provider,
    model,
    prompt,
    settings,
    status: "skipped" as const,
    startedAt: at,
    completedAt: at,
    elapsedMs: 0,
    error: "Skipped because the source image generation failed.",
  }
}

function average(jobs: BenchmarkJob[], model: string) {
  const succeeded = jobs.filter(
    (job) => job.model === model && job.status === "succeeded"
  )
  if (succeeded.length === 0) return "-"
  return formatDuration(
    succeeded.reduce((total, job) => total + job.elapsedMs, 0) /
      succeeded.length
  )
}

function markdownReport(
  startedAt: string,
  completedAt: string,
  jobs: BenchmarkJob[]
) {
  const rows = jobs.map(
    (job) =>
      `| ${job.name} | ${job.provider} | ${job.model} | ${job.status} | ${formatDuration(job.elapsedMs)} | ${job.providerJobId ?? "-"} |`
  )
  return [
    "# Media Generation Benchmark",
    "",
    `Started: ${startedAt}`,
    `Completed: ${completedAt}`,
    "",
    "## Averages",
    "",
    "| Model | Average Successful Duration |",
    "| --- | ---: |",
    `| WaveSpeed GPT Image 2 | ${average(jobs, "openai/gpt-image-2/text-to-image")} |`,
    `| Replicate Grok Image Quality | ${average(jobs, "xai/grok-imagine-image-quality")} |`,
    `| WaveSpeed Seedance Turbo | ${average(jobs, "bytedance/seedance-2.0/image-to-video-turbo")} |`,
    `| Replicate Grok Video | ${average(jobs, "xai/grok-imagine-video")} |`,
    "",
    "## Jobs",
    "",
    "| Run | Provider | Model | Status | Duration | Provider Job ID |",
    "| --- | --- | --- | --- | ---: | --- |",
    ...rows,
    "",
    "Full output URLs, prompts and errors are included in the adjacent JSON result file.",
    "",
  ].join("\n")
}

async function main() {
  const startedAt = new Date().toISOString()
  const jobs: BenchmarkJob[] = []
  const sources: PipelineSource[] = []

  console.log("Sequential media benchmark")
  console.log(
    "Runs: 3 GPT images -> Seedance videos, then 3 Grok images -> Grok videos"
  )
  console.log(
    "GPT: Medium tier (2k), 16:9 | Grok image: 2k, 16:9 | Videos: 720p, 5s"
  )

  for (let index = 0; index < RUNS; index += 1) {
    const prompt = IMAGE_PROMPTS[index]
    const name = `GPT image ${index + 1}/${RUNS}`
    const result = await timedJob(
      {
        name,
        pipeline: "gpt-seedance",
        stage: "image",
        provider: "wavespeed",
        model: "openai/gpt-image-2/text-to-image",
        prompt,
        settings: {
          aspect_ratio: "16:9",
          quality: "medium",
          resolution: "2k",
          output_format: "png",
        },
      },
      () =>
        runWaveSpeed(
          "/openai/gpt-image-2/text-to-image",
          {
            prompt,
            aspect_ratio: "16:9",
            quality: "medium",
            resolution: "2k",
            output_format: "png",
            enable_sync_mode: false,
            enable_base64_output: false,
          },
          name
        )
    )
    jobs.push(result.job)
    if (result.result)
      sources.push({ pipeline: "gpt-seedance", index, image: result.result })
  }

  for (let index = 0; index < RUNS; index += 1) {
    const prompt = IMAGE_PROMPTS[index]
    const name = `Grok image ${index + 1}/${RUNS}`
    const result = await timedJob(
      {
        name,
        pipeline: "grok-grok-video",
        stage: "image",
        provider: "replicate",
        model: "xai/grok-imagine-image-quality",
        prompt,
        settings: { aspect_ratio: "16:9", resolution: "2k" },
      },
      () =>
        runReplicate(
          "xai/grok-imagine-image-quality",
          {
            prompt,
            aspect_ratio: "16:9",
            resolution: "2k",
          },
          name
        )
    )
    jobs.push(result.job)
    if (result.result)
      sources.push({ pipeline: "grok-grok-video", index, image: result.result })
  }

  for (let index = 0; index < RUNS; index += 1) {
    const name = `Seedance video ${index + 1}/${RUNS}`
    const source = sources.find(
      (candidate) =>
        candidate.pipeline === "gpt-seedance" && candidate.index === index
    )
    const settings = {
      aspect_ratio: "16:9",
      resolution: "720p",
      duration: 5,
      generate_audio: true,
    }
    if (!source) {
      jobs.push(
        skippedVideo(
          name,
          "gpt-seedance",
          "wavespeed",
          "bytedance/seedance-2.0/image-to-video-turbo",
          VIDEO_PROMPT,
          settings
        )
      )
      continue
    }
    const result = await timedJob(
      {
        name,
        pipeline: "gpt-seedance",
        stage: "video",
        provider: "wavespeed",
        model: "bytedance/seedance-2.0/image-to-video-turbo",
        prompt: VIDEO_PROMPT,
        settings,
      },
      () =>
        runWaveSpeed(
          "/bytedance/seedance-2.0/image-to-video-turbo",
          {
            prompt: VIDEO_PROMPT,
            image: source.image.url,
            aspect_ratio: "16:9",
            resolution: "720p",
            duration: 5,
            enable_web_search: false,
            generate_audio: true,
          },
          name
        )
    )
    jobs.push(result.job)
  }

  for (let index = 0; index < RUNS; index += 1) {
    const name = `Grok video ${index + 1}/${RUNS}`
    const source = sources.find(
      (candidate) =>
        candidate.pipeline === "grok-grok-video" && candidate.index === index
    )
    const settings = { aspect_ratio: "16:9", resolution: "720p", duration: 5 }
    if (!source) {
      jobs.push(
        skippedVideo(
          name,
          "grok-grok-video",
          "replicate",
          "xai/grok-imagine-video",
          VIDEO_PROMPT,
          settings
        )
      )
      continue
    }
    const result = await timedJob(
      {
        name,
        pipeline: "grok-grok-video",
        stage: "video",
        provider: "replicate",
        model: "xai/grok-imagine-video",
        prompt: VIDEO_PROMPT,
        settings,
      },
      () =>
        runReplicate(
          "xai/grok-imagine-video",
          {
            prompt: VIDEO_PROMPT,
            image: source.image.url,
            aspect_ratio: "16:9",
            resolution: "720p",
            duration: 5,
          },
          name
        )
    )
    jobs.push(result.job)
  }

  const completedAt = new Date().toISOString()
  const suffix = startedAt.replaceAll(":", "-").replaceAll(".", "-")
  const directory = join(process.cwd(), "benchmark-results")
  await mkdir(directory, { recursive: true })
  const jsonPath = join(directory, `benchmark-${suffix}.json`)
  const markdownPath = join(directory, `benchmark-${suffix}.md`)
  const report = { startedAt, completedAt, sequential: true, jobs }
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8")
  await writeFile(
    markdownPath,
    markdownReport(startedAt, completedAt, jobs),
    "utf8"
  )

  console.log("\nBenchmark complete")
  console.log(
    `  GPT image average:       ${average(jobs, "openai/gpt-image-2/text-to-image")}`
  )
  console.log(
    `  Grok image average:      ${average(jobs, "xai/grok-imagine-image-quality")}`
  )
  console.log(
    `  Seedance video average:  ${average(jobs, "bytedance/seedance-2.0/image-to-video-turbo")}`
  )
  console.log(
    `  Grok video average:      ${average(jobs, "xai/grok-imagine-video")}`
  )
  console.log(`  JSON report: ${jsonPath}`)
  console.log(`  Markdown report: ${markdownPath}`)
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
