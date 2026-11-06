import { describe, expect, test } from "bun:test"
import {
  filterModels,
  parseBenchmarkList,
  sortModels,
  type ModelRecord,
} from "./catalog"

function model(
  overrides: Partial<ModelRecord> & { id: string },
): ModelRecord {
  const [lab = "test"] = overrides.id.split("/")
  const base: ModelRecord = {
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    lab,
    labName: lab,
    family: undefined,
    description: undefined,
    type: "chat",
    modalities: { input: ["text"], output: ["text"] },
    context: 0,
    maxOutput: 0,
    reasoning: false,
    toolCall: false,
    structuredOutput: false,
    attachment: false,
    openWeights: false,
    knowledge: undefined,
    releaseDate: undefined,
    lastUpdated: undefined,
    cost: null,
    priceSource: undefined,
    providerCount: 0,
    benchmarks: [],
  }
  return { ...base, ...overrides }
}

describe("filterModels", () => {
  const models = [
    model({
      id: "anthropic/claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      lab: "anthropic",
      labName: "Anthropic",
      family: "claude-sonnet",
    }),
    model({
      id: "openai/gpt-5",
      name: "GPT-5",
      lab: "openai",
      labName: "OpenAI",
    }),
  ]

  test("matches name, lab, and family tokens", () => {
    expect(filterModels(models, "claude").map((item) => item.id)).toEqual([
      "anthropic/claude-sonnet-4-5",
    ])
    expect(filterModels(models, "openai gpt").map((item) => item.id)).toEqual([
      "openai/gpt-5",
    ])
    expect(
      filterModels(models, "anthropic sonnet").map((item) => item.id),
    ).toEqual(["anthropic/claude-sonnet-4-5"])
  })

  test("returns every model for an empty query", () => {
    expect(filterModels(models, "")).toHaveLength(2)
    expect(filterModels(models, "   ")).toHaveLength(2)
  })

  test("returns nothing when no model matches", () => {
    expect(filterModels(models, "gemini")).toHaveLength(0)
  })
})

describe("sortModels", () => {
  const models = [
    model({
      id: "a/cheap",
      name: "Cheap",
      context: 128_000,
      releaseDate: "2025-01-01",
      cost: {
        input: 1,
        output: 2,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
    }),
    model({
      id: "b/expensive",
      name: "Expensive",
      context: 1_000_000,
      releaseDate: "2026-01-01",
      cost: {
        input: 10,
        output: 20,
        cacheRead: undefined,
        cacheWrite: undefined,
      },
    }),
    model({
      id: "c/unpriced",
      name: "Unpriced",
      releaseDate: "2024-01-01",
    }),
  ]

  test("sorts by newest release date", () => {
    expect(sortModels(models, "newest").map((item) => item.name)).toEqual([
      "Expensive",
      "Cheap",
      "Unpriced",
    ])
  })

  test("sorts by name", () => {
    expect(sortModels(models, "name").map((item) => item.name)).toEqual([
      "Cheap",
      "Expensive",
      "Unpriced",
    ])
  })

  test("puts priced models before unpriced ones", () => {
    expect(sortModels(models, "price").map((item) => item.name)).toEqual([
      "Cheap",
      "Expensive",
      "Unpriced",
    ])
  })

  test("sorts by context descending", () => {
    expect(sortModels(models, "context").map((item) => item.name)).toEqual([
      "Expensive",
      "Cheap",
      "Unpriced",
    ])
  })
})

describe("parseBenchmarkList", () => {
  test("keeps valid benchmark entries and drops invalid ones", () => {
    const benchmarks = parseBenchmarkList([
      {
        name: "SWE-Bench Verified",
        score: 75.6,
        metric: "percent resolved",
        source: "https://example.com",
      },
      { name: "Missing score" },
      { score: 10 },
      "not an object",
      {
        name: "Terminal-Bench",
        score: 64.2,
        variant: "Terminus-2",
        version: "2.1",
      },
    ])

    expect(benchmarks).toHaveLength(2)
    expect(benchmarks[0]).toMatchObject({
      name: "SWE-Bench Verified",
      score: 75.6,
      metric: "percent resolved",
    })
    expect(benchmarks[1]).toMatchObject({
      name: "Terminal-Bench",
      score: 64.2,
      variant: "Terminus-2",
      version: "2.1",
    })
  })

  test("returns an empty list for non-array input", () => {
    expect(parseBenchmarkList(undefined)).toEqual([])
    expect(parseBenchmarkList({ name: "nope" })).toEqual([])
  })
})
