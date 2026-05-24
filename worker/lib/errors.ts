import type { Context } from "hono"

export class ApiError extends Error {
  constructor(
    public readonly status: 400 | 404 | 409 | 413 | 422 | 500 | 502 | 503,
    public readonly code: string,
    message: string
  ) {
    super(message)
  }
}

export function errorResponse(c: Context, error: unknown) {
  if (error instanceof ApiError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status)
  }

  console.error(error)
  return c.json({ error: { code: "INTERNAL_ERROR", message: "An unexpected error occurred." } }, 500)
}
