import { createAnthropic } from "@ai-sdk/anthropic"
import { generateText } from "ai"

import type { Env } from "../types"
import { now } from "../lib/values"

function model(env: Env) {
  const provider = createAnthropic({
    baseURL: "https://opencode.ai/zen/v1",
    authToken: env.OPENCODE_ZEN_API_KEY,
  })
  return provider("claude-haiku-4-5")
}

export async function generateConversationTitle(env: Env, conversationId: string, context: string) {
  if (!env.OPENCODE_ZEN_API_KEY) {
    await failTitle(env, conversationId)
    return
  }

  try {
    const result = await generateText({
      model: model(env),
      prompt: [
        "Create a concise title for an image-generation conversation.",
        "Use 2 to 5 words. Use no quotation marks or ending punctuation.",
        "Return only the title.",
        "",
        `Prompt context: ${context.slice(0, 1200)}`,
      ].join("\n"),
    })
    const title = result.text.trim().replace(/^["']|["']$/g, "").replace(/[.!?]+$/, "").slice(0, 80)
    if (!title) {
      await failTitle(env, conversationId)
      return
    }
    await env.DB.prepare("UPDATE conversations SET title = ?, title_status = 'generated', updated_at = ? WHERE id = ? AND title_status = 'generating'")
      .bind(title, now(), conversationId)
      .run()
  } catch (error) {
    console.error("Title generation failed", error)
    await failTitle(env, conversationId)
  }
}

async function failTitle(env: Env, conversationId: string) {
  await env.DB.prepare("UPDATE conversations SET title_status = 'failed', updated_at = ? WHERE id = ? AND title_status = 'generating'")
    .bind(now(), conversationId)
    .run()
}
