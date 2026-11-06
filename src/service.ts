import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const USAGE_ENDPOINT = "/api/experimental/usage/limits"
const REQUEST_TIMEOUT_MS = 5_000

type JsonObject = Record<string, unknown>

export type Meter = {
  percent: number
  limited: boolean
  resetsAt: number
}

export type UsageData = {
  workspace: {
    id: string
    name: string
    usageURL: string
  }
  go: {
    rolling: Meter
    weekly: Meter
    monthly: Meter
  }
}

export type ServiceConfig = {
  url: string
  password: string
}

export class UsageError extends Error {
  readonly title: string
  readonly detail: string
  readonly hint: string | undefined

  constructor(title: string, detail: string, hint?: string, options?: ErrorOptions) {
    super(title, options)
    this.name = "UsageError"
    this.title = title
    this.detail = detail
    this.hint = hint
  }
}

export async function loadServiceConfig(): Promise<ServiceConfig> {
  const state = await readStateFile()
  const urlValue = nonEmpty(process.env.OPENCODE_SERVICE_URL) ?? nonEmpty(state?.url)
  const password =
    nonEmpty(process.env.OPENCODE_SERVICE_PASSWORD) ?? nonEmpty(state?.password)

  if (!urlValue || !password) {
    const file = serviceConfigPath()
    throw new UsageError(
      "OpenCode service not found",
      state === null
        ? `No service config was found at ${file}.`
        : `The service config at ${file} is missing its URL or password.`,
      "Start the background service with `opencode service start`, then press r.",
    )
  }

  return {
    url: validateServiceUrl(urlValue),
    password,
  }
}

export async function fetchUsage(config: ServiceConfig): Promise<UsageData> {
  const authorization = Buffer.from(
    `opencode:${config.password}`,
    "utf8",
  ).toString("base64")

  let response: Response
  try {
    response = await fetch(new URL(USAGE_ENDPOINT, config.url), {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Basic ${authorization}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw new UsageError(
        "OpenCode is taking too long",
        `The background service at ${config.url} did not answer within 5 seconds.`,
        "Check `opencode service status`, then press r.",
        { cause: error },
      )
    }
    throw new UsageError(
      "Can't reach OpenCode",
      `The background service at ${config.url} did not respond.`,
      "Start it with `opencode service start`, then press r.",
      { cause: error },
    )
  }

  if (response.status === 401) {
    throw new UsageError(
      "Service authentication failed",
      "OpenCode rejected the saved service password.",
      "Restart the service with `opencode service restart`, then press r.",
    )
  }

  if (!response.ok) {
    throw new UsageError(
      "OpenCode returned an error",
      `The usage endpoint returned HTTP ${response.status}.`,
      "Check `opencode service status` or the OpenCode logs, then press r.",
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new UsageError(
      "Unexpected response from OpenCode",
      "The usage endpoint did not return valid JSON.",
      "OpenCode may have changed its experimental usage API.",
      { cause: error },
    )
  }

  return parseUsageResponse(body)
}

export function toUsageError(error: unknown): UsageError {
  if (error instanceof UsageError) return error

  const message = error instanceof Error ? error.message : String(error)
  return new UsageError(
    "Something went wrong",
    message.trim() || "An unexpected error occurred.",
    "Press r to retry.",
  )
}

export function serviceConfigPath(): string {
  return join(stateDirectory(), "opencode", "service.json")
}

async function readStateFile(): Promise<JsonObject | null> {
  const file = serviceConfigPath()
  let raw: string

  try {
    raw = await readFile(file, "utf8")
  } catch (error) {
    if (isErrno(error, "ENOENT")) return null
    throw new UsageError(
      "Couldn't read the OpenCode service config",
      `Tried to read ${file}.`,
      "Check that the OpenCode state directory is readable.",
      { cause: error },
    )
  }

  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) throw new Error("expected a JSON object")
    return parsed
  } catch (error) {
    throw new UsageError(
      "Couldn't parse the OpenCode service config",
      `The file at ${file} is not valid JSON.`,
      "Restart the OpenCode background service to regenerate it.",
      { cause: error },
    )
  }
}

function stateDirectory(): string {
  const xdgStateHome = process.env.XDG_STATE_HOME
  if (xdgStateHome && isAbsolute(xdgStateHome)) return xdgStateHome
  return join(homedir(), ".local", "state")
}

function validateServiceUrl(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new UsageError(
      "Invalid OpenCode service URL",
      `The configured service URL is not valid: ${value}`,
      "Check the OpenCode service config.",
      { cause: error },
    )
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UsageError(
      "Invalid OpenCode service URL",
      `The service URL must use http or https, not ${url.protocol}.`,
      "Check the OpenCode service config.",
    )
  }

  const host = url.hostname.replace(/^\[|\]$/g, "")
  if (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") {
    throw new UsageError(
      "Refusing to use a non-local OpenCode service",
      `The configured service URL points at ${url.hostname}.`,
      "oc-usage only sends the service password to localhost.",
    )
  }

  return url.origin
}

function parseUsageResponse(body: unknown): UsageData {
  if (body === null) throw notSignedIn()
  if (!isObject(body)) throw invalidResponse()

  const data = "data" in body ? body.data : body
  if (data === null || data === undefined) throw notSignedIn()
  if (!isObject(data)) throw invalidResponse()

  const go = data.go
  if (go === null) throw noGoSubscription()
  if (!isObject(go)) throw invalidResponse()

  const workspace = data.workspace
  if (!isObject(workspace)) throw invalidResponse()

  return {
    workspace: {
      id: stringField(workspace.id) ?? "",
      name: stringField(workspace.name) ?? "OpenCode workspace",
      usageURL:
        stringField(workspace.usageURL) ?? "https://opencode.ai/console",
    },
    go: {
      rolling: parseMeter(go.rolling, "5-hour"),
      weekly: parseMeter(go.weekly, "weekly"),
      monthly: parseMeter(go.monthly, "monthly"),
    },
  }
}

function parseMeter(value: unknown, name: string): Meter {
  if (!isObject(value)) {
    throw invalidResponse(`The ${name} window is missing from the usage response.`)
  }

  const percent = numberField(value.percent)
  const resetsAt = timestampField(value.resetsAt)
  if (percent === undefined || resetsAt === undefined) {
    throw invalidResponse(`The ${name} window is missing percent or reset data.`)
  }

  return {
    percent,
    limited: value.limited === true,
    resetsAt,
  }
}

function notSignedIn(): UsageError {
  return new UsageError(
    "Not signed in to OpenCode",
    "OpenCode is not signed in to an OpenCode Console workspace.",
    "Run `opencode auth login` and select OpenCode, then press r.",
  )
}

function noGoSubscription(): UsageError {
  return new UsageError(
    "No OpenCode Go subscription",
    "This workspace does not have an active OpenCode Go plan.",
    "Visit https://opencode.ai/go for plan details, then press r.",
  )
}

function invalidResponse(
  detail = "The usage response was missing expected fields.",
): UsageError {
  return new UsageError(
    "Unexpected response from OpenCode",
    detail,
    "OpenCode may have changed its experimental usage API. Update oc-usage or OpenCode, then press r.",
  )
}

function nonEmpty(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function stringField(value: unknown): string | undefined {
  return nonEmpty(value)
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function timestampField(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined

  const numeric = Number(value)
  if (Number.isFinite(numeric)) return numeric

  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? undefined : parsed
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  )
}
