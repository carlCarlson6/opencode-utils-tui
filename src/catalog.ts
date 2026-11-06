import { mkdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, isAbsolute, join } from "node:path"

const MODELS_URL = "https://models.dev/models.json"
const PRICING_URL = "https://models.dev/api.json"
const FETCH_TIMEOUT_MS = 20_000
const DEFAULT_TTL_HOURS = 12
const CACHE_VERSION = 1

const MODELS_CACHE = "models.dev.models.json"
const PRICING_CACHE = "models.dev.pricing.json"

type JsonObject = Record<string, unknown>

export type Cost = {
  input: number | undefined
  output: number | undefined
  cacheRead: number | undefined
  cacheWrite: number | undefined
}

export type Benchmark = {
  name: string
  score: number
  metric: string | undefined
  variant: string | undefined
  dataset: string | undefined
  version: string | undefined
  source: string | undefined
}

export type ModelRecord = {
  id: string
  name: string
  lab: string
  labName: string
  family: string | undefined
  description: string | undefined
  type: string
  modalities: {
    input: string[]
    output: string[]
  }
  context: number
  maxOutput: number
  reasoning: boolean
  toolCall: boolean
  structuredOutput: boolean | undefined
  attachment: boolean
  openWeights: boolean
  knowledge: string | undefined
  releaseDate: string | undefined
  lastUpdated: string | undefined
  cost: Cost | null
  priceSource: string | undefined
  providerCount: number
  benchmarks: Benchmark[]
}

export type Catalog = {
  models: ModelRecord[]
  fetchedAt: number
  pricingFetchedAt: number | null
  stale: boolean
}

export type SortKey = "newest" | "name" | "price" | "context"

export const SORT_LABELS: Record<SortKey, string> = {
  newest: "newest",
  name: "name",
  price: "price",
  context: "context",
}

export const SORT_KEYS: SortKey[] = ["newest", "name", "price", "context"]

export class CatalogError extends Error {
  readonly title: string
  readonly detail: string
  readonly hint: string | undefined

  constructor(
    title: string,
    detail: string,
    hint?: string,
    options?: ErrorOptions,
  ) {
    super(title, options)
    this.name = "CatalogError"
    this.title = title
    this.detail = detail
    this.hint = hint
  }
}

type CacheEntry = {
  version: number
  fetchedAt: number
  data: unknown
}

type PriceCandidate = {
  providerID: string
  providerName: string
  cost: Cost
  score: number
}

type PricingIndex = {
  byCanonical: Map<string, PriceCandidate>
  byPair: Map<string, Cost>
  counts: Map<string, number>
  providerNames: Map<string, string>
  capabilities: Map<
    string,
    { structuredOutput: boolean | undefined }
  >
}

export type LoadOptions = {
  force?: boolean
  offline?: boolean
}

export async function loadCatalog(
  options: LoadOptions = {},
): Promise<Catalog> {
  const ttl = cacheTtlMs()
  const now = Date.now()

  const cachedModels = await readCache(MODELS_CACHE)
  const cachedPricing = await readCache(PRICING_CACHE)
  const modelsFresh =
    cachedModels !== null && now - cachedModels.fetchedAt < ttl
  const pricingFresh =
    cachedPricing !== null && now - cachedPricing.fetchedAt < ttl

  let modelsRaw: unknown
  let modelsFetchedAt: number
  let modelsStale = false

  if (!options.force && modelsFresh) {
    modelsRaw = cachedModels.data
    modelsFetchedAt = cachedModels.fetchedAt
  } else if (options.offline) {
    if (!cachedModels) {
      throw new CatalogError(
        "No cached model catalog",
        `Offline mode needs a catalog at ${cacheFile(MODELS_CACHE)}.`,
        "Run once without --offline, then try again.",
      )
    }
    modelsRaw = cachedModels.data
    modelsFetchedAt = cachedModels.fetchedAt
  } else {
    try {
      modelsRaw = await fetchJson(MODELS_URL)
      modelsFetchedAt = Date.now()
      await writeCache(MODELS_CACHE, modelsRaw)
    } catch (error) {
      if (!cachedModels) throw error
      modelsRaw = cachedModels.data
      modelsFetchedAt = cachedModels.fetchedAt
      modelsStale = true
    }
  }

  let pricingRaw: unknown = null
  let pricingFetchedAt: number | null = null
  let pricingStale = false

  if (!options.force && pricingFresh) {
    pricingRaw = cachedPricing.data
    pricingFetchedAt = cachedPricing.fetchedAt
  } else if (!options.offline) {
    try {
      pricingRaw = await fetchJson(PRICING_URL)
      pricingFetchedAt = Date.now()
      await writeCache(PRICING_CACHE, pricingRaw)
    } catch {
      if (cachedPricing) {
        pricingRaw = cachedPricing.data
        pricingFetchedAt = cachedPricing.fetchedAt
        pricingStale = true
      }
    }
  } else if (cachedPricing) {
    pricingRaw = cachedPricing.data
    pricingFetchedAt = cachedPricing.fetchedAt
  }

  const pricing = buildPricing(pricingRaw)
  const models = normalizeModels(modelsRaw, pricing)

  return {
    models,
    fetchedAt: modelsFetchedAt,
    pricingFetchedAt,
    stale: modelsStale || pricingStale,
  }
}

export function filterModels(
  models: ModelRecord[],
  query: string,
): ModelRecord[] {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0)
  if (tokens.length === 0) return models

  return models.filter((model) => {
    const haystack = `${model.id} ${model.name} ${model.lab} ${model.labName} ${model.family ?? ""}`.toLowerCase()
    return tokens.every((token) => haystack.includes(token))
  })
}

export function sortModels(
  models: ModelRecord[],
  sort: SortKey,
): ModelRecord[] {
  const copy = [...models]

  switch (sort) {
    case "newest":
      return copy.sort(
        (a, b) =>
          dateValue(b.releaseDate) - dateValue(a.releaseDate) ||
          a.name.localeCompare(b.name),
      )
    case "name":
      return copy.sort((a, b) => a.name.localeCompare(b.name))
    case "price":
      return copy.sort(
        (a, b) =>
          (a.cost?.input ?? Number.POSITIVE_INFINITY) -
            (b.cost?.input ?? Number.POSITIVE_INFINITY) ||
          a.name.localeCompare(b.name),
      )
    case "context":
      return copy.sort(
        (a, b) => b.context - a.context || a.name.localeCompare(b.name),
      )
  }
}

export function parseBenchmarkList(value: unknown): Benchmark[] {
  if (!Array.isArray(value)) return []

  const benchmarks: Benchmark[] = []
  for (const item of value) {
    if (!isObject(item)) continue
    const name = stringField(item.name)
    const score = numberField(item.score)
    if (!name || score === undefined) continue

    benchmarks.push({
      name,
      score,
      metric: stringField(item.metric),
      variant: stringField(item.variant),
      dataset: stringField(item.dataset),
      version: stringField(item.version),
      source: stringField(item.source),
    })
  }
  return benchmarks
}

export function cacheDirectory(): string {
  const override = nonEmpty(process.env.OC_COMPARE_CACHE_DIR)
  if (override) return override

  const xdg = process.env.XDG_CACHE_HOME
  if (xdg && isAbsolute(xdg)) return join(xdg, "oc-usage")
  return join(homedir(), ".cache", "oc-usage")
}

function normalizeModels(
  raw: unknown,
  pricing: PricingIndex,
): ModelRecord[] {
  if (!isObject(raw)) {
    throw new CatalogError(
      "Unexpected model catalog",
      "models.dev returned a response that is not a JSON object.",
      "Try again in a moment, or update oc-compare.",
    )
  }

  const models: ModelRecord[] = []
  for (const [key, value] of Object.entries(raw)) {
    if (!isObject(value)) continue

    const id = stringField(value.id) ?? key
    const [lab = "unknown"] = id.split("/")
    const type = stringField(value.type) ?? "chat"
    const modalities = isObject(value.modalities) ? value.modalities : {}
    const limit = isObject(value.limit) ? value.limit : {}
    const candidate = pricing.byCanonical.get(id)
    const fallbackCost = pricing.byPair.get(id)
    const cost = candidate?.cost ?? fallbackCost ?? null

    models.push({
      id,
      name: stringField(value.name) ?? id,
      lab,
      labName: pricing.providerNames.get(lab) ?? prettifyLab(lab),
      family: stringField(value.family),
      description: stringField(value.description),
      type,
      modalities: {
        input: stringList(modalities.input),
        output: stringList(modalities.output),
      },
      context: numberField(limit.context) ?? 0,
      maxOutput: numberField(limit.output) ?? 0,
      reasoning: value.reasoning === true,
      toolCall: value.tool_call === true,
      structuredOutput: pricing.capabilities.get(id)?.structuredOutput,
      attachment: value.attachment === true,
      openWeights: value.open_weights === true,
      knowledge: stringField(value.knowledge),
      releaseDate: stringField(value.release_date),
      lastUpdated: stringField(value.last_updated),
      cost,
      priceSource: candidate?.providerName,
      providerCount: pricing.counts.get(id) ?? 0,
      benchmarks: parseBenchmarkList(value.benchmarks),
    })
  }

  return models.sort((a, b) => a.name.localeCompare(b.name))
}

function buildPricing(raw: unknown): PricingIndex {
  const index: PricingIndex = {
    byCanonical: new Map(),
    byPair: new Map(),
    counts: new Map(),
    providerNames: new Map(),
    capabilities: new Map(),
  }
  if (!isObject(raw)) return index

  for (const providerValue of Object.values(raw)) {
    if (!isObject(providerValue)) continue

    const providerID = stringField(providerValue.id) ?? ""
    const providerName =
      stringField(providerValue.name) ?? providerID
    if (providerID) index.providerNames.set(providerID, providerName)

    const providerModels = isObject(providerValue.models)
      ? providerValue.models
      : {}

    for (const [modelID, modelValue] of Object.entries(providerModels)) {
      if (!isObject(modelValue)) continue

      const canonical = stringField(modelValue.canonical_model_id)
      if (canonical) {
        index.counts.set(canonical, (index.counts.get(canonical) ?? 0) + 1)

        const capability = index.capabilities.get(canonical) ?? {
          structuredOutput: undefined,
        }
        if (modelValue.structured_output === true) {
          capability.structuredOutput = true
        } else if (
          modelValue.structured_output === false &&
          capability.structuredOutput === undefined
        ) {
          capability.structuredOutput = false
        }
        index.capabilities.set(canonical, capability)
      }

      const cost = parseCost(modelValue.cost)
      if (!cost) continue

      const pair = `${providerID}/${modelID}`
      if (!index.byPair.has(pair)) index.byPair.set(pair, cost)
      if (!canonical) continue

      const candidate: PriceCandidate = {
        providerID,
        providerName,
        cost,
        score: providerScore(providerID, canonical),
      }
      const current = index.byCanonical.get(canonical)
      if (!current || betterPrice(candidate, current)) {
        index.byCanonical.set(canonical, candidate)
      }
    }
  }

  return index
}

const CREDIBLE_PROVIDERS = new Set([
  "amazon-bedrock",
  "azure",
  "azure-cognitive-services",
  "cerebras",
  "cloudflare",
  "cloudflare-workers-ai",
  "deepinfra",
  "fireworks",
  "fireworks-ai",
  "google-vertex",
  "groq",
  "hyperbolic",
  "novita",
  "novita-ai",
  "openrouter",
  "sambanova",
  "together",
  "togetherai",
  "vercel",
])

function providerScore(providerID: string, canonical: string): number {
  const lab = canonical.split("/")[0] ?? ""
  // Subscription, token-plan, and free tiers are not comparable list prices.
  if (/plan|token|free|promo|trial/i.test(providerID)) return 10
  if (providerID === lab) return 100
  if (providerID === "openrouter") return 80
  // OpenCode's own plans can carry promotional or subscription pricing that
  // differs from the model's list price, so keep them as a fallback only.
  if (providerID === "opencode") return 60
  if (providerID === "opencode-go") return 55
  if (CREDIBLE_PROVIDERS.has(providerID)) return 70
  if (
    lab.length > 2 &&
    (providerID.includes(lab) || lab.includes(providerID))
  ) {
    return 70
  }
  return 10
}

function betterPrice(
  candidate: PriceCandidate,
  current: PriceCandidate,
): boolean {
  const candidateCredible = candidate.score >= 70
  const currentCredible = current.score >= 70

  // Prefer a credible provider over a promotional or marginal one. Among
  // credible providers, show the cheapest list price; this lines up closely
  // with the price OpenCode Data reports for the same canonical model.
  if (candidateCredible !== currentCredible) return candidateCredible

  if (candidateCredible) {
    const candidateInput =
      candidate.cost.input ?? Number.POSITIVE_INFINITY
    const currentInput = current.cost.input ?? Number.POSITIVE_INFINITY
    if (candidateInput !== currentInput) return candidateInput < currentInput

    const candidateOutput =
      candidate.cost.output ?? Number.POSITIVE_INFINITY
    const currentOutput = current.cost.output ?? Number.POSITIVE_INFINITY
    if (candidateOutput !== currentOutput) {
      return candidateOutput < currentOutput
    }
    if (candidate.score !== current.score) {
      return candidate.score > current.score
    }
  } else if (candidate.score !== current.score) {
    return candidate.score > current.score
  }

  return candidate.providerName.localeCompare(current.providerName) < 0
}

function parseCost(value: unknown): Cost | null {
  if (!isObject(value)) return null

  const input = numberField(value.input)
  const output = numberField(value.output)
  if (input === undefined && output === undefined) return null

  return {
    input,
    output,
    cacheRead: numberField(value.cache_read),
    cacheWrite: numberField(value.cache_write),
  }
}

async function fetchJson(url: string): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, {
      headers: {
        Accept: "application/json",
        "User-Agent": "oc-compare/0.1.0",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (error) {
    throw new CatalogError(
      "Can't reach models.dev",
      `The request to ${url} did not respond.`,
      "Check your connection, then press r.",
      { cause: error },
    )
  }

  if (!response.ok) {
    throw new CatalogError(
      "models.dev returned an error",
      `${url} answered with HTTP ${response.status}.`,
      "Try again in a moment, then press r.",
    )
  }

  try {
    return await response.json()
  } catch (error) {
    throw new CatalogError(
      "Unexpected response from models.dev",
      `${url} did not return valid JSON.`,
      "models.dev may be having trouble. Press r to retry.",
      { cause: error },
    )
  }
}

async function readCache(fileName: string): Promise<CacheEntry | null> {
  const file = cacheFile(fileName)
  try {
    const raw = await readFile(file, "utf8")
    const parsed: unknown = JSON.parse(raw)
    if (!isObject(parsed)) return null
    if (parsed.version !== CACHE_VERSION) return null
    if (typeof parsed.fetchedAt !== "number") return null
    if (parsed.data === null || parsed.data === undefined) return null
    return {
      version: CACHE_VERSION,
      fetchedAt: parsed.fetchedAt,
      data: parsed.data,
    }
  } catch {
    return null
  }
}

async function writeCache(fileName: string, data: unknown): Promise<void> {
  const file = cacheFile(fileName)
  try {
    await mkdir(dirname(file), { recursive: true })
    await writeFile(
      file,
      JSON.stringify({
        version: CACHE_VERSION,
        fetchedAt: Date.now(),
        data,
      }),
      "utf8",
    )
  } catch {
    // A read-only home directory should not stop the catalog from loading.
  }
}

function cacheFile(fileName: string): string {
  return join(cacheDirectory(), fileName)
}

function cacheTtlMs(): number {
  const hours = Number(process.env.OC_COMPARE_TTL_HOURS)
  const effective =
    Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_TTL_HOURS
  return effective * 3_600_000
}

function dateValue(value: string | undefined): number {
  if (!value) return 0
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? 0 : parsed
}

function prettifyLab(lab: string): string {
  if (lab.length === 0) return "Unknown"
  return lab
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is string => typeof item === "string" && item.length > 0,
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
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
