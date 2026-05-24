import { spawnSync } from "node:child_process"

const WORKER_NAME = "creator-generator-app-prod"
const REQUIRED_SECRETS = [
  "REPLICATE_API_TOKEN",
  "WAVESPEED_API_KEY",
  "OPENCODE_ZEN_API_KEY",
] as const
const OPTIONAL_SECRETS = ["REPLICATE_WEBHOOK_SIGNING_SECRET"] as const

const dryRun = process.argv.includes("--dry-run")
const missing = REQUIRED_SECRETS.filter((key) => !process.env[key]?.trim())

if (missing.length > 0) {
  console.error(`Missing required local values: ${missing.join(", ")}`)
  console.error(
    "Set them in .env or in the process environment before running this command."
  )
  process.exit(1)
}

const values = Object.fromEntries(
  [...REQUIRED_SECRETS, ...OPTIONAL_SECRETS]
    .filter((key) => Boolean(process.env[key]?.trim()))
    .map((key) => [key, process.env[key]!])
)
const names = Object.keys(values)

console.log(`Target Worker: ${WORKER_NAME}`)
console.log(`Secrets to upload: ${names.join(", ")}`)
for (const key of OPTIONAL_SECRETS) {
  if (!values[key]) console.log(`Optional value not set, skipping: ${key}`)
}

if (dryRun) {
  console.log("Dry run only; no Cloudflare secrets were changed.")
  process.exit(0)
}

const processResult = spawnSync(
  "npx",
  ["wrangler", "secret", "bulk", "--name", WORKER_NAME],
  {
    input: JSON.stringify(values),
    stdio: ["pipe", "inherit", "inherit"],
  }
)

if (processResult.status !== 0) {
  console.error("Secret upload failed.")
  process.exit(processResult.status ?? 1)
}

console.log(`Uploaded ${names.length} secret value(s) to ${WORKER_NAME}.`)
