import { createCliRenderer, type CliRenderer } from "@opentui/core"
import { createDashboard, type DashboardState } from "./dashboard"
import { fetchUsage, loadServiceConfig, toUsageError } from "./service"
import { theme } from "./theme"
import type { UsageData } from "./service"

const VERSION = "0.1.0"
const REFRESH_INTERVAL_MS = 60_000
const ERROR_RETRY_MS = 10_000
const RESET_RECHECK_MS = 2_000
const TICK_MS = 1_000

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
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Could not start the TUI: ${message}`)
    process.exitCode = 1
    return
  }

  const dashboard = createDashboard(renderer)
  const triggeredResets = new Set<number>()
  let refreshing = false
  let shuttingDown = false

  let state: DashboardState = {
    data: null,
    error: null,
    lastUpdated: null,
    loading: true,
    nextRefreshAt: Date.now(),
  }

  const render = (): void => dashboard.update(state)

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
      const data = await fetchUsage(config)
      const now = Date.now()

      state = {
        data,
        error: null,
        lastUpdated: now,
        loading: false,
        nextRefreshAt: now + REFRESH_INTERVAL_MS,
      }
      pruneTriggeredResets(data)
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

    renderer.destroy()
    try {
      await renderer.closed
    } finally {
      process.exit(0)
    }
  }

  renderer.keyInput.on("keypress", (key) => {
    if (key.eventType === "release") return

    const name = key.name.toLowerCase()
    if (name === "q") {
      void shutdown()
      return
    }
    if (name === "r") {
      requestRefresh()
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
    render()
  }, TICK_MS)

  render()
  void refresh()
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
