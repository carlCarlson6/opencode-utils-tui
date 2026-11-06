import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { isAbsolute, join } from "node:path"

const USAGE_ENDPOINT = "/api/experimental/usage/limits"
const CREDENTIAL_ENDPOINT = "/api/credential"
const CONSOLE_USAGE_ENDPOINT = "/api/usage/summary"
const MICRO_CENTS_PER_DOLLAR = 100_000_000
const REQUEST_TIMEOUT_MS = 5_000
const ACTIVITY_CONCURRENCY = 4

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

export type PeriodStats = {
  cost: number
  requests: number
  tokens: number
}

export type StatsData = {
  today: PeriodStats
  week: PeriodStats
  month: PeriodStats
}

export type ActivityDay = {
  date: string
  day: number
  cost: number
  requests: number
  tokens: number
}

export type ActivityForecast = {
  spent: number
  perDay: number
  projected: number
}

export type ActivityData = {
  month: string
  label: string
  daysInMonth: number
  today: number
  days: ActivityDay[]
  forecast: {
    cost: ActivityForecast
    requests: ActivityForecast
    tokens: ActivityForecast
  }
}

type ConsoleCredential = {
  accessToken: string
  orgID: string
  userID: string | undefined
  baseURL: string
}

type ConsoleUsageQuery =
  | { range: "24h" }
  | { from: string; to: string }

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
  const body = await requestEndpoint(config, USAGE_ENDPOINT, "usage")
  return parseUsageResponse(body)
}

export async function fetchStats(
  config: ServiceConfig,
  now = Date.now(),
): Promise<StatsData> {
  const credential = await fetchConsoleCredential(config)
  const queries = consoleUsageQueries(now)
  const [today, week, month] = await Promise.all([
    fetchConsoleSummary(credential, queries.today),
    fetchConsoleSummary(credential, queries.week),
    fetchConsoleSummary(credential, queries.month),
  ])
  return { today, week, month }
}

export async function fetchActivity(
  config: ServiceConfig,
  now = Date.now(),
): Promise<ActivityData> {
  const credential = await fetchConsoleCredential(config)
  const today = new Date(now).getUTCDate()
  const dates: string[] = []
  for (let day = 1; day <= today; day++) {
    dates.push(utcMonthDay(now, day))
  }

  const summaries = await mapLimit(dates, ACTIVITY_CONCURRENCY, (date) =>
    fetchConsoleSummary(credential, { from: date, to: date }),
  )

  const days: ActivityDay[] = dates.map((date, index) => {
    const stats = summaries[index] ?? { cost: 0, requests: 0, tokens: 0 }
    return {
      date,
      day: index + 1,
      cost: stats.cost,
      requests: stats.requests,
      tokens: stats.tokens,
    }
  })

  const pristine = days.length
  const metric = (pick: (day: ActivityDay) => number): ActivityForecast => {
    let spent = 0
    for (const day of days) spent += pick(day)
    const perDay = pristine > 0 ? spent / pristine : 0
    return { spent, perDay, projected: perDay * daysInUtcMonth(now) }
  }

  return {
    month: utcDate(now).slice(0, 7),
    label: monthLabel(now),
    daysInMonth: daysInUtcMonth(now),
    today,
    days,
    forecast: {
      cost: metric((day) => day.cost),
      requests: metric((day) => day.requests),
      tokens: metric((day) => day.tokens),
    },
  }
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0

  const worker = async (): Promise<void> => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }

  const workers = Array.from(
    { length: Math.min(Math.max(1, limit), items.length) },
    () => worker(),
  )
  await Promise.all(workers)
  return results
}

function consoleUsageQueries(now: number): {
  today: ConsoleUsageQuery
  week: ConsoleUsageQuery
  month: ConsoleUsageQuery
} {
  const today = utcDate(now)
  return {
    today: { range: "24h" },
    week: { from: startOfUtcWeek(now), to: today },
    month: { from: startOfUtcMonth(now), to: today },
  }
}

async function fetchConsoleCredential(
  config: ServiceConfig,
): Promise<ConsoleCredential> {
  const body = await requestEndpoint(config, CREDENTIAL_ENDPOINT, "credentials")
  if (!isObject(body)) {
    throw invalidResponse("The credentials response was missing expected fields.")
  }

  const entries = body.data
  if (!Array.isArray(entries)) {
    throw invalidResponse("The credentials response was not a list.")
  }

  const entry = entries.find(
    (item): item is JsonObject =>
      isObject(item) &&
      item.integrationID === "opencode" &&
      item.active === true,
  )
  if (!entry || !isObject(entry.value)) throw noConsoleCredential()

  const value = entry.value
  const type = stringField(value.type)
  const accessToken =
    type === "oauth"
      ? stringField(value.access)
      : type === "key"
        ? stringField(value.key)
        : undefined
  if (!accessToken) throw noConsoleCredential()

  const metadata = isObject(value.metadata) ? value.metadata : undefined
  const orgID = metadata ? stringField(metadata.orgID) : undefined
  const userID = metadata ? stringField(metadata.accountID) : undefined
  const server = metadata ? stringField(metadata.server) : undefined
  if (!orgID || !server) throw noConsoleCredential()

  return {
    accessToken,
    orgID,
    userID,
    baseURL: validateConsoleServer(server),
  }
}

async function fetchConsoleSummary(
  credential: ConsoleCredential,
  query: ConsoleUsageQuery,
): Promise<PeriodStats> {
  const params = new URLSearchParams()
  if ("range" in query) {
    params.set("range", query.range)
  } else {
    params.set("from", query.from)
    params.set("to", query.to)
  }
  if (credential.userID) params.set("userId", credential.userID)

  let response: Response
  try {
    response = await fetch(
      `${credential.baseURL}${CONSOLE_USAGE_ENDPOINT}?${params.toString()}`,
      {
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${credential.accessToken}`,
          "x-org-id": credential.orgID,
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      },
    )
  } catch (error) {
    if (isAbortError(error)) {
      throw new UsageError(
        "OpenCode Console is taking too long",
        "The Console usage endpoint did not answer within 5 seconds.",
        "Press r to retry.",
        { cause: error },
      )
    }
    throw new UsageError(
      "Can't reach OpenCode Console",
      "The Console usage endpoint did not respond.",
      "Check your connection, then press r.",
      { cause: error },
    )
  }

  if (response.status === 401 || response.status === 403) {
    throw new UsageError(
      "OpenCode Console authentication failed",
      "The saved Console credential was rejected.",
      "Run `opencode auth login` to sign in again, then press r.",
    )
  }

  if (!response.ok) {
    throw new UsageError(
      "OpenCode Console returned an error",
      `The usage summary endpoint returned HTTP ${response.status}.`,
      "Press r to retry.",
    )
  }

  let body: unknown
  try {
    body = await response.json()
  } catch (error) {
    throw new UsageError(
      "Unexpected response from OpenCode Console",
      "The usage summary endpoint did not return valid JSON.",
      "OpenCode may have changed the Console API. Press r to retry.",
      { cause: error },
    )
  }

  return parseConsoleSummary(body)
}

async function requestEndpoint(
  config: ServiceConfig,
  path: string,
  label: string,
): Promise<unknown> {
  const authorization = Buffer.from(
    `opencode:${config.password}`,
    "utf8",
  ).toString("base64")

  let response: Response
  try {
    response = await fetch(new URL(path, config.url), {
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
      `The ${label} endpoint returned HTTP ${response.status}.`,
      "Check `opencode service status` or the OpenCode logs, then press r.",
    )
  }

  try {
    return await response.json()
  } catch (error) {
    throw new UsageError(
      "Unexpected response from OpenCode",
      `The ${label} endpoint did not return valid JSON.`,
      "OpenCode may have changed its experimental API.",
      { cause: error },
    )
  }
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

function parseConsoleSummary(body: unknown): PeriodStats {
  if (!isObject(body)) {
    throw consoleResponseError()
  }

  const costMicroCents = numericField(body.totalCostMicroCents)
  const requests = numericField(body.totalRequests)
  const inputTokens = numericField(body.totalInputTokens)
  const outputTokens = numericField(body.totalOutputTokens)
  const cacheReadTokens = numericField(body.totalCacheReadTokens)
  const cacheWrite5mTokens = numericField(body.totalCacheWrite5mTokens) ?? 0
  const cacheWrite1hTokens = numericField(body.totalCacheWrite1hTokens) ?? 0
  const cacheWriteTokens = numericField(body.totalCacheWriteTokens) ?? 0

  if (
    costMicroCents === undefined ||
    requests === undefined ||
    inputTokens === undefined ||
    outputTokens === undefined ||
    cacheReadTokens === undefined
  ) {
    throw consoleResponseError()
  }

  const writes =
    cacheWrite5mTokens + cacheWrite1hTokens > 0
      ? cacheWrite5mTokens + cacheWrite1hTokens
      : cacheWriteTokens

  return {
    cost: costMicroCents / MICRO_CENTS_PER_DOLLAR,
    requests,
    tokens: inputTokens + outputTokens + cacheReadTokens + writes,
  }
}

function consoleResponseError(): UsageError {
  return new UsageError(
    "Unexpected response from OpenCode Console",
    "The Console usage summary was missing expected fields.",
    "OpenCode may have changed the Console API. Update oc-usage or OpenCode, then press r.",
  )
}

function noConsoleCredential(): UsageError {
  return new UsageError(
    "OpenCode Console credential not found",
    "No active OpenCode Console credential was found in the local service.",
    "Sign in with `opencode auth login`, then press r.",
  )
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
    "OpenCode may have changed its experimental API. Update oc-usage or OpenCode, then press r.",
  )
}

function utcDate(now: number): string {
  return new Date(now).toISOString().slice(0, 10)
}

function utcMonthDay(now: number, day: number): string {
  const date = new Date(now)
  return utcDate(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), day))
}

function daysInUtcMonth(now: number): number {
  const date = new Date(now)
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate()
}

function monthLabel(now: number): string {
  return new Date(now).toLocaleDateString("en-US", {
    month: "long",
    timeZone: "UTC",
  })
}

function startOfUtcWeek(now: number): string {
  const date = new Date(now)
  const daysSinceMonday = (date.getUTCDay() + 6) % 7
  return utcDate(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth(),
      date.getUTCDate() - daysSinceMonday,
    ),
  )
}

function startOfUtcMonth(now: number): string {
  const date = new Date(now)
  return utcDate(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1))
}

function validateConsoleServer(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch (error) {
    throw new UsageError(
      "Invalid OpenCode Console URL",
      `The saved Console URL is not valid: ${value}`,
      "Sign in with `opencode auth login`, then press r.",
      { cause: error },
    )
  }

  if (url.protocol !== "https:") {
    throw new UsageError(
      "Invalid OpenCode Console URL",
      `The Console URL must use https, not ${url.protocol}.`,
      "Sign in with `opencode auth login`, then press r.",
    )
  }

  const host = url.hostname.toLowerCase()
  if (host !== "opencode.ai" && host !== "console.opencode.ai") {
    throw new UsageError(
      "Refusing to use a non-OpenCode Console URL",
      `The saved Console URL points at ${url.hostname}.`,
      "oc-usage only sends the Console credential to opencode.ai.",
    )
  }

  const path = url.pathname.replace(/\/+$/, "")
  return `https://opencode.ai${path === "" ? "/console" : path}`
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

function numericField(value: unknown): number | undefined {
  if (typeof value === "number") return numberField(value)
  if (typeof value !== "string" || value.trim() === "") return undefined

  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : undefined
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
