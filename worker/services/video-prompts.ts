import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"

import type { Env, VideoModel } from "../types"
import { ApiError } from "../lib/errors"

type VideoPromptRequest = {
  prompt: string
  model: VideoModel
  duration: number
  generateAudio: boolean
}

const ENHANCEMENT_INSTRUCTIONS = [
  "You rewrite user drafts into production-ready image-to-video prompts.",
  "The generation always starts from an existing source still image. Treat that frame as the visual anchor.",
  "Preserve the source subject identity, appearance, composition, style, text, and lighting unless the user's draft explicitly asks to change them.",
  "Retain every user intent. Do not introduce new characters, objects, locations, dialogue, or transformations that were not requested.",
  "Describe how the anchored scene moves over time: subject action, small secondary/environmental motion when useful, and one purposeful camera behavior.",
  "Prefer coherent, physically plausible motion and clear cinematic direction over adjective lists.",
  "Add short stability constraints when relevant, such as stable identity, consistent composition and lighting, smooth motion, no flicker or deformation.",
  "If audio is enabled, include only audio or ambience consistent with the user's action; if it is disabled, do not mention audio.",
  "Keep the result concise and executable as a single prompt, normally 45 to 100 words.",
  "Return only the enhanced prompt without a heading, analysis, quotation marks, or markdown.",
].join("\n")

function zenModel(env: Env) {
  const zen = createOpenAI({
    baseURL: "https://opencode.ai/zen/v1",
    apiKey: env.OPENCODE_ZEN_API_KEY,
    name: "opencode-zen",
  })
  return zen.responses("gpt-5.5")
}

function videoModelName(model: VideoModel) {
  if (model === "bytedance/seedance-2.0/text-to-video") return "Seedance 2.0"
  if (model === "kwaivgi/kling-video-o3-pro/image-to-video") {
    return "Kling O3 Pro"
  }
  return "Grok Imagine Video"
}

export async function enhanceVideoPrompt(
  env: Env,
  request: VideoPromptRequest
) {
  if (!env.OPENCODE_ZEN_API_KEY) {
    throw new ApiError(
      503,
      "PROMPT_ENHANCEMENT_UNAVAILABLE",
      "Video prompt enhancement is not configured."
    )
  }

  try {
    const result = await generateText({
      model: zenModel(env),
      system: ENHANCEMENT_INSTRUCTIONS,
      prompt: [
        `Target video model: ${videoModelName(request.model)}`,
        `Clip duration: ${request.duration} seconds`,
        `Generated audio: ${request.generateAudio ? "enabled" : "disabled"}`,
        "User draft:",
        request.prompt,
      ].join("\n"),
      maxOutputTokens: 320,
    })
    const prompt = result.text.trim().replace(/^(["'])|(["'])$/g, "")
    if (!prompt) {
      throw new Error("The enhancement model returned an empty prompt.")
    }
    return prompt.slice(0, 1500)
  } catch (error) {
    console.error("Video prompt enhancement failed", error)
    throw new ApiError(
      502,
      "PROMPT_ENHANCEMENT_FAILED",
      "The video prompt could not be enhanced right now."
    )
  }
}
