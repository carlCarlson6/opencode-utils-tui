import {
  CliRenderEvents,
  createCliRenderer,
  type CliRenderer,
} from "@opentui/core"
import { createCompareSession } from "./compare"
import {
  createDashboard,
  type DashboardState,
  type InsightPeriod,
  type InsightsTab,
} from "./dashboard"
import {
  fetchActiveSessions,
  fetchActivity,
  fetchProjectUsage,
  fetchSessionStatsBundle,
  fetchStats,
  fetchUsage,
  loadServiceConfig,
  toUsageError,
} from "./service"
import { theme } from "./theme"
import type { ProjectUsage, UsageData } from "./service"

const VERSION = "0.2.0"
const REFRESH_INTERVAL_MS = 60_000
const ERROR_RETRY_MS = 10_000
const RESET_RECHECK_MS = 2_000
const TICK_MS = 1_000
const ACTIVE_REFRESH_MS = 10_000
const PROJECT_REFRESH_MS = 5 * 60_000

const INSIGHTS_TABS: InsightsTab[] = [
  "activity",
  "models",
  "tools",
  "projects",
  "efficiency",
]
const INSIGHT_PERIODS: InsightPeriod[] = ["today", "week", "month"]

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (hasFlag(args, "--help", "-h")) {
    printHelp()
    return
  }

  if (hasFlag(args, "--version", "-v")) {
    console.log(`oc-usage ${VERSION}`)
    return
  }

  if (!process.stdout.isTTY) {
    console.error("oc-usage must run in an interactive terminal.")
    process.exitCode = 1
    return
  }

  let tickTimer: ReturnType<typeof setInterval> | null = null
  let activeTimer: ReturnType<typeof setInterval> | null = null

  let renderer: CliRenderer
  try {
    renderer = await createCliRenderer({
      exitOnCtrlC: true,
      exitSignals: ["SIGINT", "SIGTERM"],
      backgroundColor: theme.background,
      onDestroy: () => {
        if (tickTimer) {
          clearInterval(tickTimer)
          tickTimer = null
        }
        if (activeTimer) {
          clearInterval(activeTimer)
          activeTimer = null
        }
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Could not start the TUI: ${message}`)
    process.exitCode = 1
    return
  }

  const dashboard = createDashboard(renderer)
  const compare = createCompareSession(renderer, { embedded: true })
  const compareResizeHandler = (width: number, height: number): void => {
    compare.reflow(width, height)
  }
  renderer.on(CliRenderEvents.RESIZE, compareResizeHandler)

  let mode: "dashboard" | "compare" = "dashboard"
  const triggeredResets = new Set<number>()
  let refreshing = false
  let shuttingDown = false
  let projectCache: { at: number; data: ProjectUsage[] } | null = null

  let state: DashboardState = {
    data: null,
    stats: null,
    activity: null,
    error: null,
    statsError: null,
    activityError: null,
    sessionStats: null,
    sessionStatsError: null,
    projectUsage: null,
    projectUsageError: null,
    running: 0,
    metric: "cost",
    showInsights: true,
    insightsTab: "activity",
    insightsPeriod: "month",
    lastUpdated: null,
    loading: true,
    nextRefreshAt: Date.now(),
  }

  const render = (): void => dashboard.update(state)

  const openCompare = (): void => {
    if (mode === "compare") return
    mode = "compare"
    dashboard.setVisible(false)
    compare.activate()
    compare.reflow(renderer.width, renderer.height)
  }

  const closeCompare = (): void => {
    if (mode === "dashboard") return
    mode = "dashboard"
    compare.deactivate()
    dashboard.setVisible(true)
    dashboard.reflow(renderer.width, renderer.height)
    render()
  }

  const pruneTriggeredResets = (data: UsageData): void => {
    const active = new Set([
      data.go.rolling.resetsAt,
      data.go.weekly.resetsAt,
      data.go.monthly.resetsAt,
    ])
    for (const timestamp of triggeredResets) {
      if (!active.has(timestamp)) triggeredResets.delete(timestamp)
    }
  }

  const checkResets = (now: number): void => {
    if (!state.data) return
    const meters = [
      state.data.go.rolling,
      state.data.go.weekly,
      state.data.go.monthly,
    ]

    for (const meter of meters) {
      if (meter.resetsAt <= now && !triggeredResets.has(meter.resetsAt)) {
        triggeredResets.add(meter.resetsAt)
        state = {
          ...state,
          nextRefreshAt: Math.min(
            state.nextRefreshAt,
            now + RESET_RECHECK_MS,
          ),
        }
      }
    }
  }

  const refresh = async (): Promise<void> => {
    if (refreshing || shuttingDown) return

    refreshing = true
    state = { ...state, loading: true }
    render()

    try {
      const config = await loadServiceConfig()
      const now = Date.now()
      const cachedProjects = projectCache
      const projectsPromise: Promise<ProjectUsage[]> =
        cachedProjects !== null && now - cachedProjects.at < PROJECT_REFRESH_MS
          ? Promise.resolve(cachedProjects.data)
          : fetchProjectUsage(config, now).then((data) => {
              projectCache = { at: Date.now(), data }
              return data
            })

      const [
        usageResult,
        statsResult,
        activityResult,
        localStatsResult,
        projectsResult,
        activeResult,
      ] = await Promise.allSettled([
        fetchUsage(config),
        fetchStats(config),
        fetchActivity(config),
        fetchSessionStatsBundle(config, now),
        projectsPromise,
        fetchActiveSessions(config),
      ])
      const refreshedAt = Date.now()
      const stats =
        statsResult.status === "fulfilled" ? statsResult.value : state.stats
      const statsError =
        statsResult.status === "rejected"
          ? toUsageError(statsResult.reason)
          : null
      const activity =
        activityResult.status === "fulfilled"
          ? activityResult.value
          : state.activity
      const activityError =
        activityResult.status === "rejected"
          ? toUsageError(activityResult.reason)
          : null
      const sessionStats =
        localStatsResult.status === "fulfilled"
          ? localStatsResult.value
          : state.sessionStats
      const sessionStatsError =
        localStatsResult.status === "rejected"
          ? toUsageError(localStatsResult.reason)
          : null
      const projectUsage =
        projectsResult.status === "fulfilled"
          ? projectsResult.value
          : state.projectUsage
      const projectUsageError =
        projectsResult.status === "rejected"
          ? toUsageError(projectsResult.reason)
          : null
      const running =
        activeResult.status === "fulfilled"
          ? activeResult.value.length
          : state.running

      if (usageResult.status === "rejected") {
        state = {
          ...state,
          stats,
          statsError,
          activity,
          activityError,
          sessionStats,
          sessionStatsError,
          projectUsage,
          projectUsageError,
          running,
          error: toUsageError(usageResult.reason),
          loading: false,
          nextRefreshAt: refreshedAt + ERROR_RETRY_MS,
        }
      } else {
        const data = usageResult.value
        state = {
          ...state,
          data,
          stats,
          activity,
          error: null,
          statsError,
          activityError,
          sessionStats,
          sessionStatsError,
          projectUsage,
          projectUsageError,
          running,
          lastUpdated: refreshedAt,
          loading: false,
          nextRefreshAt: refreshedAt + REFRESH_INTERVAL_MS,
        }
        pruneTriggeredResets(data)
      }
    } catch (error) {
      state = {
        ...state,
        error: toUsageError(error),
        loading: false,
        nextRefreshAt: Date.now() + ERROR_RETRY_MS,
      }
    } finally {
      refreshing = false
      render()
    }
  }

  const refreshActive = async (): Promise<void> => {
    if (shuttingDown) return

    try {
      const config = await loadServiceConfig()
      const sessions = await fetchActiveSessions(config)
      if (sessions.length !== state.running) {
        state = { ...state, running: sessions.length }
        render()
      }
    } catch {
      // Active-session polling is best-effort; the main refresh handles errors.
    }
  }

  const requestRefresh = (): void => {
    state = { ...state, nextRefreshAt: Date.now() }
    void refresh()
  }

  const openConsole = (): void => {
    const url = state.data?.workspace.usageURL
    if (!url || !/^https?:\/\//i.test(url)) return

    const command =
      process.platform === "darwin"
        ? ["open", url]
        : process.platform === "win32"
          ? ["cmd", "/c", "start", "", url]
          : ["xdg-open", url]

    try {
      Bun.spawn(command, { stdout: "ignore", stderr: "ignore" }).unref()
    } catch {
      // Opening the browser is best-effort.
    }
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }
    if (activeTimer) {
      clearInterval(activeTimer)
      activeTimer = null
    }

    renderer.off(CliRenderEvents.RESIZE, compareResizeHandler)
    compare.destroy()
    renderer.destroy()
    try {
      await renderer.closed
    } finally {
      process.exit(0)
    }
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.eventType === "release") return

    if (mode === "compare") {
      const result = compare.handleKey(key)
      if (result === "exit") closeCompare()
      else if (result === "quit") void shutdown()
      return
    }

    const name = key.name.toLowerCase()
    if (name === "c") {
      openCompare()
      return
    }
    if (name === "q") {
      void shutdown()
      return
    }
    if (name === "r") {
      requestRefresh()
      return
    }
    if (name === "g") {
      state = { ...state, showInsights: !state.showInsights }
      render()
      return
    }
    if (name === "t") {
      state = { ...state, insightsTab: nextInsightsTab(state.insightsTab) }
      render()
      return
    }
    if (
      name === "p" &&
      (state.insightsTab === "models" || state.insightsTab === "tools")
    ) {
      state = { ...state, insightsPeriod: nextInsightPeriod(state.insightsPeriod) }
      render()
      return
    }
    if (name === "m") {
      state = { ...state, metric: nextMetric(state.metric) }
      render()
      return
    }
    if (name === "o") {
      openConsole()
    }
  })

  tickTimer = setInterval(() => {
    const now = Date.now()
    checkResets(now)
    if (!refreshing && now >= state.nextRefreshAt) void refresh()
    if (mode === "compare") {
      compare.tick()
    } else {
      render()
    }
  }, TICK_MS)

  activeTimer = setInterval(() => {
    void refreshActive()
  }, ACTIVE_REFRESH_MS)

  render()
  void refresh()
  void refreshActive()
}

function nextMetric(metric: DashboardState["metric"]): DashboardState["metric"] {
  if (metric === "cost") return "requests"
  if (metric === "requests") return "tokens"
  return "cost"
}

function nextInsightsTab(tab: InsightsTab): InsightsTab {
  const index = INSIGHTS_TABS.indexOf(tab)
  return INSIGHTS_TABS[(index + 1) % INSIGHTS_TABS.length] as InsightsTab
}

function nextInsightPeriod(period: InsightPeriod): InsightPeriod {
  const index = INSIGHT_PERIODS.indexOf(period)
  return INSIGHT_PERIODS[(index + 1) % INSIGHT_PERIODS.length] as InsightPeriod
}

function printHelp(): void {
  console.log(`oc-usage ${VERSION}

OpenCode Go usage dashboard.

Usage:
  oc-usage [options]

Options:
  -h, --help       Show this help
  -v, --version    Show version

Keys:
  r  Refresh now
  t  Cycle the insights tab (activity, models, tools, projects, efficiency)
  p  Cycle the insights period (today, week, month)
  g  Toggle the insights panel
  c  Open the model comparison
  m  Cycle the graph metric (cost, requests, tokens)
  o  Open OpenCode Console
  q  Quit

Reads usage from the local OpenCode background service.
Set OPENCODE_SERVICE_URL and OPENCODE_SERVICE_PASSWORD to override discovery.`)
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg))
}

void main().catch((error: unknown) => {
  console.error("oc-usage failed:", error)
  process.exit(1)
})
