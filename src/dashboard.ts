import {
  BoxRenderable,
  CliRenderEvents,
  StyledText,
  TextAttributes,
  TextRenderable,
  bold,
  fg,
  isStyledText,
  stringToStyledText,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import {
  clampPercent,
  formatAgo,
  formatCost,
  formatCostPerRequest,
  formatCount,
  formatDuration,
  formatLatency,
  formatMetricValue,
  formatPercent,
  formatResetClock,
  formatShort,
  formatTokens,
  meterColor,
  projectLabel,
  remainingPercent,
  renderBar,
  truncateText,
  type Metric,
} from "./format"
import { layout, theme } from "./theme"
import type {
  ActivityData,
  Meter,
  PeriodStats,
  ProjectUsage,
  SessionStats,
  SessionStatsBundle,
  StatsData,
  UsageData,
  UsageError,
} from "./service"

export type InsightsTab =
  | "activity"
  | "models"
  | "tools"
  | "projects"
  | "efficiency"

export type InsightPeriod = "today" | "week" | "month"

export type DashboardState = {
  data: UsageData | null
  stats: StatsData | null
  activity: ActivityData | null
  error: UsageError | null
  statsError: UsageError | null
  activityError: UsageError | null
  sessionStats: SessionStatsBundle | null
  sessionStatsError: UsageError | null
  projectUsage: ProjectUsage[] | null
  projectUsageError: UsageError | null
  running: number
  metric: Metric
  showInsights: boolean
  insightsTab: InsightsTab
  insightsPeriod: InsightPeriod
  lastUpdated: number | null
  loading: boolean
  nextRefreshAt: number
}

export type Dashboard = {
  update(state: DashboardState): void
  reflow(width: number, height: number): void
  destroy(): void
}

type MeterCard = {
  box: BoxRenderable
  update(meter: Meter | null, now: number): void
  setWidth(width: number): void
}

type StatsPanel = {
  box: BoxRenderable
  update(
    stats: StatsData | null,
    error: UsageError | null,
    sessionStats: SessionStatsBundle | null,
    sessionStatsError: UsageError | null,
  ): void
  setWidth(width: number): void
}

type InsightsPanel = {
  box: BoxRenderable
  update(
    activity: ActivityData | null,
    activityError: UsageError | null,
    stats: StatsData | null,
    statsError: UsageError | null,
    sessionStats: SessionStatsBundle | null,
    sessionStatsError: UsageError | null,
    projectUsage: ProjectUsage[] | null,
    projectUsageError: UsageError | null,
    metric: Metric,
    tab: InsightsTab,
    period: InsightPeriod,
  ): void
  setWidth(width: number): void
}

type Overlay = {
  show(
    title: string,
    detail: string,
    hint: string,
    color: string,
    retry: boolean,
  ): void
  hide(): void
}

export function createDashboard(renderer: CliRenderer): Dashboard {
  let currentState: DashboardState = {
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
  let currentWidth = renderer.width
  let currentHeight = renderer.height
  let insightsAttached = false

  const root = new BoxRenderable(renderer, {
    id: "dashboard",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    gap: 1,
    padding: layout.rootPadding,
    backgroundColor: theme.background,
  })
  renderer.root.add(root)

  const header = new BoxRenderable(renderer, {
    id: "header",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexShrink: 0,
  })
  const headerLeft = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    flexGrow: 1,
    flexShrink: 1,
  })
  const headerRight = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    flexShrink: 0,
    fg: theme.dim,
  })
  header.add(headerLeft)
  header.add(headerRight)
  root.add(header)

  const cardsArea = new BoxRenderable(renderer, {
    id: "cards-area",
    flexGrow: 1,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "stretch",
    gap: 1,
  })
  const cardsRow = new BoxRenderable(renderer, {
    id: "cards-row",
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: 1,
    flexShrink: 0,
  })
  cardsArea.add(cardsRow)

  const cards = [
    createMeterCard(renderer, "5-hour window", 5 * 3_600_000),
    createMeterCard(renderer, "Weekly", 7 * 86_400_000),
    createMeterCard(renderer, "Monthly", 30 * 86_400_000),
  ]
  for (const card of cards) cardsRow.add(card.box)

  const statsPanel = createStatsPanel(renderer)
  const insightsPanel = createInsightsPanel(renderer)
  cardsArea.add(statsPanel.box)
  root.add(cardsArea)

  const footer = new BoxRenderable(renderer, {
    id: "footer",
    height: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    flexShrink: 0,
  })
  const footerLeft = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    flexGrow: 1,
    flexShrink: 1,
    fg: theme.dim,
  })
  const footerRight = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    flexShrink: 0,
    fg: theme.dim,
  })
  footer.add(footerLeft)
  footer.add(footerRight)
  root.add(footer)

  const overlay = createOverlay(renderer)
  root.add(overlay.box)

  const resizeHandler = (width: number, height: number) => reflow(width, height)
  renderer.on(CliRenderEvents.RESIZE, resizeHandler)

  function reflow(width: number, height: number): void {
    currentWidth = width
    currentHeight = height

    const contentWidth = Math.max(0, width - layout.rootPadding * 2)
    const columns = contentWidth >= 74 ? 3 : contentWidth >= 49 ? 2 : 1
    const gap = 1
    const cardWidth = Math.max(
      layout.cardMinWidth,
      Math.floor((contentWidth - gap * (columns - 1)) / columns),
    )

    for (const card of cards) card.setWidth(cardWidth)
    statsPanel.setWidth(contentWidth)
    insightsPanel.setWidth(contentWidth)
    renderState()
  }

  function renderState(): void {
    const state = currentState
    const now = Date.now()

    const showInsights =
      state.showInsights && currentHeight >= layout.minHeightForInsights
    if (showInsights !== insightsAttached) {
      if (showInsights) cardsArea.add(insightsPanel.box)
      else cardsArea.remove(insightsPanel.box)
      insightsAttached = showInsights
    }

    const data = state.data
    const error = state.error
    const limited = data
      ? data.go.rolling.limited ||
        data.go.weekly.limited ||
        data.go.monthly.limited
      : false
    const tooSmall =
      currentWidth < layout.minWidth || currentHeight < layout.minHeight

    const workspace = data
      ? truncateText(data.workspace.name, 42)
      : undefined

    headerLeft.content = workspace
      ? compose(
          fg(theme.accent)(bold("◆ OpenCode Go")),
          fg(theme.dim)(` · ${workspace}`),
        )
      : compose(
          fg(theme.accent)(bold("◆ OpenCode Go")),
          fg(theme.dim)(" · usage"),
        )

    headerRight.content = compose(
      ...headerStatus(state, now, limited),
    )

    cards[0]?.update(data?.go.rolling ?? null, now)
    cards[1]?.update(data?.go.weekly ?? null, now)
    cards[2]?.update(data?.go.monthly ?? null, now)

    statsPanel.update(
      state.stats,
      state.statsError,
      state.sessionStats,
      state.sessionStatsError,
    )
    insightsPanel.update(
      state.activity,
      state.activityError,
      state.stats,
      state.statsError,
      state.sessionStats,
      state.sessionStatsError,
      state.projectUsage,
      state.projectUsageError,
      state.metric,
      state.insightsTab,
      state.insightsPeriod,
    )

    const retrying = error !== null && !state.loading
    const canOpen = Boolean(data?.workspace.usageURL)
    const isRetry = error !== null && data === null

    const keyParts: Array<string | TextChunk | StyledText> = [
      fg(theme.accent)(bold("r")),
      isRetry ? " retry" : " refresh",
    ]
    if (showInsights && state.insightsTab === "activity") {
      keyParts.push(
        "  ",
        fg(theme.accent)(bold("m")),
        ` ${state.metric}`,
      )
    }
    keyParts.push("  ", fg(theme.accent)(bold("t")), " tab")
    if (
      showInsights &&
      (state.insightsTab === "models" || state.insightsTab === "tools")
    ) {
      keyParts.push("  ", fg(theme.accent)(bold("p")), " period")
    }
    keyParts.push("  ", fg(theme.accent)(bold("g")), " panel")
    if (canOpen) {
      keyParts.push("  ", fg(theme.accent)(bold("o")), " console")
    }
    keyParts.push("  ", fg(theme.accent)(bold("q")), " quit")
    footerLeft.content = compose(...keyParts)

    if (state.loading) {
      footerRight.fg = theme.dim
      footerRight.content = data ? "refreshing…" : "connecting…"
    } else if (retrying) {
      footerRight.fg = theme.amber
      footerRight.content = `retrying in ${formatShort(
        Math.max(0, state.nextRefreshAt - now),
      )}`
    } else {
      footerRight.fg = theme.dim
      footerRight.content = "60s auto-refresh"
    }

    if (tooSmall) {
      overlay.show(
        "Terminal too small",
        `Need at least ${layout.minWidth}x${layout.minHeight}. Current size: ${currentWidth}x${currentHeight}.`,
        "Resize the terminal or press q.",
        theme.amber,
        false,
      )
    } else if (error && !data) {
      overlay.show(
        error.title,
        error.detail,
        state.loading ? "Retrying now…" : (error.hint ?? "Press r to retry."),
        errorColor(error),
        !state.loading,
      )
    } else {
      overlay.hide()
    }

    renderer.requestRender()
  }

  const dashboard: Dashboard = {
    update(state) {
      currentState = state
      renderState()
    },
    reflow,
    destroy() {
      renderer.off(CliRenderEvents.RESIZE, resizeHandler)
    },
  }

  reflow(renderer.width, renderer.height)
  return dashboard
}

function createMeterCard(
  renderer: CliRenderer,
  title: string,
  windowMs: number,
): MeterCard {
  let barWidth = 24

  const box = new BoxRenderable(renderer, {
    height: layout.cardHeight,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.cardBorder,
    title: ` ${title} `,
    titleColor: theme.dim,
    titleAlignment: "left",
    backgroundColor: theme.card,
    paddingLeft: 1,
    paddingRight: 1,
  })

  const primaryText = new TextRenderable(renderer, {
    content: "--% used",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    attributes: TextAttributes.BOLD,
    fg: theme.faint,
  })
  const barText = new TextRenderable(renderer, {
    content: renderBar(0, barWidth, theme.faint),
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
  })
  const leftText = new TextRenderable(renderer, {
    content: "--% left",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    fg: theme.faint,
  })
  const resetInText = new TextRenderable(renderer, {
    content: "Waiting for data",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    fg: theme.faint,
  })
  const resetAtText = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    fg: theme.faint,
  })

  box.add(primaryText)
  box.add(barText)
  box.add(leftText)
  box.add(resetInText)
  box.add(resetAtText)

  return {
    box,
    setWidth(width) {
      box.width = width
      barWidth = Math.max(12, width - 4)
    },
    update(meter, now) {
      if (!meter) {
        box.title = ` ${title} `
        box.titleColor = theme.dim
        box.borderColor = theme.cardBorder
        primaryText.content = "--% used"
        primaryText.fg = theme.faint
        barText.content = renderBar(0, barWidth, theme.faint)
        leftText.content = "--% left"
        leftText.fg = theme.faint
        resetInText.content = "Waiting for data"
        resetInText.fg = theme.faint
        resetAtText.content = ""
        return
      }

      const usedPercent = meter.limited
        ? 100
        : clampPercent(meter.percent)
      const remaining = meter.limited
        ? 0
        : Math.round(remainingPercent(meter.percent))
      const usedLabel = meter.limited ? "100%" : formatPercent(meter.percent)
      const color = meterColor(remaining, meter.limited)
      const pace = meter.limited ? null : paceProjection(meter, windowMs, now)
      const paceWarning = pace !== null && pace.projected > 100
      const paceColor =
        pace !== null && pace.projected >= 150 ? theme.red : theme.amber

      box.title = meter.limited
        ? ` ${title} · LIMITED `
        : paceWarning && pace
          ? ` ${title} · ⚠ ${Math.round(pace.projected)}% `
          : ` ${title} `
      box.titleColor = meter.limited
        ? color
        : paceWarning
          ? paceColor
          : color
      box.borderColor = meter.limited
        ? theme.red
        : paceWarning
          ? paceColor
          : theme.cardBorder

      primaryText.content = `${usedLabel} used`
      primaryText.fg = color
      barText.content = renderBar(usedPercent, barWidth, color)
      leftText.content = meter.limited
        ? "0% left · LIMIT REACHED"
        : `${remaining}% left`
      leftText.fg = meter.limited ? theme.red : theme.dim

      if (meter.resetsAt <= now) {
        resetInText.content = "Resetting…"
        resetInText.fg = theme.accent
        resetAtText.content = "Waiting for data"
      } else {
        resetInText.content = `Resets in ${formatDuration(meter.resetsAt - now)}`
        resetInText.fg = theme.text
        resetAtText.content = formatResetClock(meter.resetsAt, now)
      }
      resetAtText.fg = theme.dim
    },
  }
}

function paceProjection(
  meter: Meter,
  windowMs: number,
  now: number,
): { projected: number } | null {
  if (meter.limited || meter.percent <= 0) return null

  const remainingMs = meter.resetsAt - now
  if (remainingMs <= 0) return null

  const elapsedMs = windowMs - remainingMs
  if (elapsedMs <= 0 || elapsedMs < windowMs * 0.05) return null

  const projected = (meter.percent / elapsedMs) * windowMs
  return { projected }
}

function createStatsPanel(renderer: CliRenderer): StatsPanel {
  let panelWidth = 78
  let currentStats: StatsData | null = null
  let currentError: UsageError | null = null
  let currentSessionStats: SessionStatsBundle | null = null
  let currentSessionStatsError: UsageError | null = null

  const box = new BoxRenderable(renderer, {
    id: "stats",
    height: layout.statsHeight,
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.cardBorder,
    title: " Usage ",
    titleColor: theme.dim,
    titleAlignment: "left",
    backgroundColor: theme.card,
    paddingLeft: 1,
    paddingRight: 1,
  })

  const headerRow = createStatsRow(renderer)
  const costRow = createStatsRow(renderer)
  const requestsRow = createStatsRow(renderer)
  const tokensRow = createStatsRow(renderer)
  box.add(headerRow)
  box.add(costRow)
  box.add(requestsRow)
  box.add(tokensRow)

  function renderRow(
    label: string,
    color: string,
    formatValue: (period: PeriodStats) => string,
    labelWidth: number,
    columnWidth: number,
    gap: number,
  ): StyledText {
    const periods = currentStats
      ? [currentStats.today, currentStats.week, currentStats.month]
      : null
    const valueColor = !currentStats
      ? theme.faint
      : currentError
        ? theme.dim
        : color
    const values = periods ? periods.map(formatValue) : ["--", "--", "--"]

    return compose(
      fg(theme.dim)(label.padEnd(labelWidth)),
      ...values.map((value) =>
        fg(valueColor)(`${value.padStart(columnWidth)}${" ".repeat(gap)}`),
      ),
    )
  }

  function pulseTitle(): string {
    const today = currentSessionStats?.today
    if (!today) return ""

    const parts = [
      `${formatCount(today.sessions)} sessions`,
      `${formatCount(today.steps)} steps`,
      `${formatCount(today.tools.totals.calls)} calls`,
      `${formatCount(today.tools.totals.failed)} failed`,
    ]
    const streak = currentSessionStats?.all.streak ?? 0
    if (streak > 1) parts.push(`${streak}d streak`)

    const maxLength = Math.max(0, panelWidth - 12)
    let pulse = ""
    for (const part of parts) {
      const next = pulse ? `${pulse} · ${part}` : part
      if (next.length > maxLength) break
      pulse = next
    }
    return pulse
  }

  function render(): void {
    const pulse = pulseTitle()
    if (currentError) {
      box.title = currentStats ? " Usage · stale " : " Usage · unavailable "
      box.titleColor = theme.amber
    } else if (pulse) {
      box.title = ` Usage · ${pulse} `
      box.titleColor = currentSessionStatsError ? theme.amber : theme.dim
    } else {
      box.title = " Usage "
      box.titleColor = theme.dim
    }

    const inner = Math.max(0, panelWidth - 4)
    const labelWidth = Math.min(14, Math.max(9, Math.floor(inner * 0.18)))
    const gap = 2
    const columnWidth = Math.max(
      6,
      Math.floor((inner - labelWidth - gap * 3) / 3),
    )

    headerRow.content = compose(
      fg(theme.dim)("".padEnd(labelWidth)),
      ...["Today", "This week", "This month"].map((header) =>
        fg(theme.dim)(`${header.padStart(columnWidth)}${" ".repeat(gap)}`),
      ),
    )

    costRow.content = renderRow(
      "Cost",
      theme.green,
      (period) => formatCost(period.cost),
      labelWidth,
      columnWidth,
      gap,
    )
    requestsRow.content = renderRow(
      "Requests",
      theme.accent,
      (period) => formatCount(period.requests),
      labelWidth,
      columnWidth,
      gap,
    )
    tokensRow.content = renderRow(
      "Tokens",
      theme.text,
      (period) => formatTokens(period.tokens),
      labelWidth,
      columnWidth,
      gap,
    )
  }

  render()

  return {
    box,
    update(stats, error, sessionStats, sessionStatsError) {
      currentStats = stats
      currentError = error
      currentSessionStats = sessionStats
      currentSessionStatsError = sessionStatsError
      render()
    },
    setWidth(width) {
      panelWidth = Math.max(0, width)
      render()
    },
  }
}

function createInsightsPanel(renderer: CliRenderer): InsightsPanel {
  let panelWidth = 78
  let activity: ActivityData | null = null
  let activityError: UsageError | null = null
  let stats: StatsData | null = null
  let statsError: UsageError | null = null
  let sessionStats: SessionStatsBundle | null = null
  let sessionStatsError: UsageError | null = null
  let projectUsage: ProjectUsage[] | null = null
  let projectUsageError: UsageError | null = null
  let metric: Metric = "cost"
  let tab: InsightsTab = "activity"
  let period: InsightPeriod = "month"

  const box = new BoxRenderable(renderer, {
    id: "insights",
    height: layout.insightsHeight,
    flexShrink: 0,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.cardBorder,
    title: " Activity ",
    titleColor: theme.dim,
    titleAlignment: "left",
    backgroundColor: theme.card,
    paddingLeft: 1,
    paddingRight: 1,
  })

  const rows = Array.from(
    { length: layout.insightsChartHeight },
    () =>
      new TextRenderable(renderer, {
        content: "",
        height: 1,
        wrapMode: "none",
        truncate: true,
        selectable: false,
      }),
  )
  for (const row of rows) box.add(row)

  function clearRows(): void {
    for (const row of rows) row.content = ""
  }

  function setTitle(title: string, error: UsageError | null): void {
    box.title = title
    box.titleColor = error ? theme.amber : theme.dim
    box.borderColor = error ? theme.amber : theme.cardBorder
  }

  function showMessage(message: string): void {
    clearRows()
    rows[rows.length - 1]!.content = compose(fg(theme.faint)(message))
  }

  function periodLabel(value: InsightPeriod): string {
    if (value === "today") return "Today"
    if (value === "week") return "This week"
    return "This month"
  }

  function renderActivity(): void {
    if (!activity) {
      setTitle(
        activityError ? " Activity · unavailable " : " Activity ",
        activityError,
      )
      showMessage(
        activityError
          ? "Activity history unavailable"
          : "Waiting for activity history",
      )
      return
    }

    const forecast = activity.forecast[metric]
    const inner = Math.max(1, panelWidth - 4)
    const totalDays = activity.daysInMonth
    const today = Math.min(Math.max(1, activity.today), totalDays)
    const columns = Math.max(1, Math.min(totalDays, inner))
    const startDay = totalDays - columns + 1

    const byDay = new Map<number, number>()
    for (const day of activity.days) {
      byDay.set(
        day.day,
        metric === "cost"
          ? day.cost
          : metric === "requests"
            ? day.requests
            : day.tokens,
      )
    }

    const values: number[] = []
    const isForecast: boolean[] = []
    for (let column = 0; column < columns; column++) {
      const day = startDay + column
      const future = day > today
      isForecast.push(future)
      values.push(future ? forecast.perDay : (byDay.get(day) ?? 0))
    }

    let max = forecast.perDay
    for (const value of values) if (value > max) max = value
    if (!(max > 0)) max = 0

    const height = layout.insightsChartHeight
    const level = (value: number): number => {
      if (!(value > 0) || !(max > 0)) return 0
      return Math.max(1, Math.round((value / max) * height))
    }
    const levels = values.map(level)

    for (let row = 0; row < height; row++) {
      const threshold = height - row
      const parts: Array<string | TextChunk | StyledText> = []
      let buffer = ""
      let color: string | null = null
      const flush = (): void => {
        if (buffer.length === 0) return
        parts.push(color ? fg(color)(buffer) : buffer)
        buffer = ""
      }

      for (let column = 0; column < columns; column++) {
        const filled = (levels[column] ?? 0) >= threshold
        const nextColor = filled
          ? isForecast[column]
            ? theme.faint
            : theme.accent
          : null
        if (nextColor !== color) {
          flush()
          color = nextColor
        }
        buffer += filled ? (isForecast[column] ? "░" : "█") : " "
      }
      flush()

      rows[row]!.content = parts.length > 0 ? compose(...parts) : ""
    }

    if (!(max > 0)) {
      rows[height - 1]!.content = compose(
        fg(theme.faint)("·".repeat(columns)),
      )
    }

    const spent = formatMetricValue(forecast.spent, metric)
    const projected = formatMetricValue(forecast.projected, metric)
    setTitle(
      ` Activity · ${activity.label} · ${spent} spent · ${projected} forecast${
        activityError ? " · stale " : " "
      }`,
      activityError,
    )
  }

  function renderModels(): void {
    const data: SessionStats | undefined = sessionStats?.[period]
    if (!data) {
      setTitle(
        ` Models · ${periodLabel(period)} `,
        sessionStatsError,
      )
      showMessage(
        sessionStatsError
          ? "Local session stats unavailable"
          : "Waiting for local session stats",
      )
      return
    }

    const goModels = data.models.filter(
      (item) => item.model.providerID === "opencode-go" && item.steps > 0,
    )
    const pool = (
      goModels.length > 0
        ? goModels
        : data.models.filter((item) => item.steps > 0)
    ).sort((a, b) => b.steps - a.steps)
    const scope = goModels.length > 0 ? "Go" : "all providers"
    const total = pool.reduce((sum, item) => sum + item.steps, 0)

    setTitle(
      ` Models · ${periodLabel(period)} · ${scope} · ${formatCount(total)} steps${
        sessionStatsError ? " · stale " : " "
      }`,
      sessionStatsError,
    )

    if (pool.length === 0) {
      showMessage("No model usage recorded")
      return
    }

    const inner = Math.max(1, panelWidth - 4)
    const labelWidth = Math.min(30, Math.max(15, Math.floor(inner * 0.36)))
    const countWidth = 7
    const percentWidth = 5
    const barWidth = Math.max(
      8,
      inner - labelWidth - countWidth - percentWidth - 3,
    )

    for (let index = 0; index < rows.length; index++) {
      const item = pool[index]
      if (!item) continue

      const variant =
        item.model.variant && item.model.variant !== "default"
          ? `:${item.model.variant}`
          : ""
      const provider = goModels.length > 0 ? "" : `${item.model.providerID}/`
      const label = truncateText(
        `${provider}${item.model.id}${variant}`,
        labelWidth,
      )
      const share = total > 0 ? (item.steps / total) * 100 : 0

      rows[index]!.content = compose(
        fg(theme.text)(label.padEnd(labelWidth)),
        fg(theme.dim)(formatCount(item.steps).padStart(countWidth)),
        " ",
        renderBar(share, barWidth, theme.accent),
        " ",
        fg(theme.dim)(`${Math.round(share)}%`.padStart(percentWidth)),
      )
    }
  }

  function renderTools(): void {
    const data: SessionStats | undefined = sessionStats?.[period]
    if (!data) {
      setTitle(
        ` Tools · ${periodLabel(period)} `,
        sessionStatsError,
      )
      showMessage(
        sessionStatsError
          ? "Local session stats unavailable"
          : "Waiting for local session stats",
      )
      return
    }

    const usage = [...data.tools.usage]
      .filter((tool) => tool.calls > 0)
      .sort((a, b) => b.calls - a.calls)
    const totals = data.tools.totals

    setTitle(
      ` Tools · ${periodLabel(period)} · ${formatCount(totals.calls)} calls · ${formatCount(
        totals.failed,
      )} failed${sessionStatsError ? " · stale " : " "}`,
      sessionStatsError,
    )

    if (usage.length === 0) {
      showMessage("No tool calls recorded")
      return
    }

    const inner = Math.max(1, panelWidth - 4)
    const nameWidth = Math.min(20, Math.max(10, Math.floor(inner * 0.24)))
    const callsWidth = 8
    const failedWidth = 10
    const latencyWidth = 11

    for (let index = 0; index < rows.length; index++) {
      const tool = usage[index]
      if (!tool) continue

      const failed = tool.failed > 0 ? `${formatCount(tool.failed)} fail` : "ok"
      rows[index]!.content = compose(
        fg(theme.text)(truncateText(tool.name, nameWidth).padEnd(nameWidth)),
        fg(theme.accent)(formatCount(tool.calls).padStart(callsWidth)),
        "  ",
        fg(tool.failed > 0 ? theme.red : theme.dim)(
          failed.padEnd(failedWidth),
        ),
        fg(theme.dim)(
          `p50 ${formatLatency(tool.durationP50)}`.padStart(latencyWidth),
        ),
      )
    }
  }

  function renderProjects(): void {
    if (!projectUsage) {
      setTitle(" Projects · This month ", projectUsageError)
      showMessage(
        projectUsageError
          ? "Project usage unavailable"
          : "Waiting for project usage",
      )
      return
    }

    const total = projectUsage.reduce((sum, item) => sum + item.steps, 0)
    setTitle(
      ` Projects · This month · ${formatCount(total)} local steps${
        projectUsageError ? " · stale " : " "
      }`,
      projectUsageError,
    )

    if (projectUsage.length === 0) {
      showMessage("No project usage recorded")
      return
    }

    const inner = Math.max(1, panelWidth - 4)
    const labelWidth = Math.min(28, Math.max(14, Math.floor(inner * 0.34)))
    const stepsWidth = 7
    const percentWidth = 5
    const barWidth = Math.max(
      8,
      inner - labelWidth - stepsWidth - percentWidth - 3,
    )

    for (let index = 0; index < rows.length; index++) {
      const project = projectUsage[index]
      if (!project) continue

      const share = total > 0 ? (project.steps / total) * 100 : 0
      rows[index]!.content = compose(
        fg(theme.text)(
          truncateText(projectLabel(project.path), labelWidth).padEnd(
            labelWidth,
          ),
        ),
        fg(theme.dim)(formatCount(project.steps).padStart(stepsWidth)),
        " ",
        renderBar(share, barWidth, theme.green),
        " ",
        fg(theme.dim)(`${Math.round(share)}%`.padStart(percentWidth)),
      )
    }
  }

  function renderEfficiency(): void {
    const periods = stats
      ? [stats.today, stats.week, stats.month]
      : null

    setTitle(
      ` Efficiency · today / week / month${
        statsError ? " · stale " : " "
      }`,
      statsError,
    )

    if (!periods) {
      showMessage(
        statsError
          ? "Console usage unavailable"
          : "Waiting for Console usage",
      )
      return
    }

    const inner = Math.max(1, panelWidth - 4)
    const labelWidth = Math.min(14, Math.max(10, Math.floor(inner * 0.2)))
    const gap = 2
    const columnWidth = Math.max(
      8,
      Math.floor((inner - labelWidth - gap * 3) / 3),
    )

    const rowsData = [
      {
        label: "Cache hit",
        color: theme.green,
        value: (item: PeriodStats): string => {
          const total =
            item.input + item.output + item.cacheRead + item.cacheWrite
          if (total <= 0) return "--"
          return `${Math.round((item.cacheRead / total) * 100)}%`
        },
      },
      {
        label: "$/request",
        color: theme.accent,
        value: (item: PeriodStats): string =>
          item.requests > 0
            ? formatCostPerRequest(item.cost / item.requests)
            : "--",
      },
      {
        label: "Tokens/req",
        color: theme.text,
        value: (item: PeriodStats): string =>
          item.requests > 0
            ? formatTokens(item.tokens / item.requests)
            : "--",
      },
    ]

    for (let index = 0; index < rows.length; index++) {
      const row = rowsData[index]
      if (!row) continue

      rows[index]!.content = compose(
        fg(theme.dim)(row.label.padEnd(labelWidth)),
        ...periods.map((item) =>
          fg(statsError ? theme.dim : row.color)(
            `${row.value(item).padStart(columnWidth)}${" ".repeat(gap)}`,
          ),
        ),
      )
    }
  }

  function render(): void {
    clearRows()

    if (tab === "activity") {
      renderActivity()
      return
    }
    if (tab === "models") {
      renderModels()
      return
    }
    if (tab === "tools") {
      renderTools()
      return
    }
    if (tab === "projects") {
      renderProjects()
      return
    }
    renderEfficiency()
  }

  render()

  return {
    box,
    update(
      nextActivity,
      nextActivityError,
      nextStats,
      nextStatsError,
      nextSessionStats,
      nextSessionStatsError,
      nextProjectUsage,
      nextProjectUsageError,
      nextMetric,
      nextTab,
      nextPeriod,
    ) {
      activity = nextActivity
      activityError = nextActivityError
      stats = nextStats
      statsError = nextStatsError
      sessionStats = nextSessionStats
      sessionStatsError = nextSessionStatsError
      projectUsage = nextProjectUsage
      projectUsageError = nextProjectUsageError
      metric = nextMetric
      tab = nextTab
      period = nextPeriod
      render()
    },
    setWidth(width) {
      panelWidth = Math.max(0, width)
      render()
    },
  }
}

function createStatsRow(renderer: CliRenderer): TextRenderable {
  return new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
  })
}

function createOverlay(renderer: CliRenderer): Overlay & { box: BoxRenderable } {
  const box = new BoxRenderable(renderer, {
    id: "overlay",
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 10,
    backgroundColor: theme.background,
    flexDirection: "column",
    justifyContent: "center",
    alignItems: "center",
    padding: 2,
    visible: false,
  })

  const panel = new BoxRenderable(renderer, {
    id: "overlay-panel",
    width: "80%",
    maxWidth: 70,
    flexDirection: "column",
    gap: 1,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.amber,
    backgroundColor: theme.card,
    padding: 2,
  })

  const titleText = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    attributes: TextAttributes.BOLD,
    fg: theme.amber,
    textAlign: "center",
  })
  const detailText = new TextRenderable(renderer, {
    content: "",
    wrapMode: "word",
    selectable: false,
    fg: theme.text,
    textAlign: "center",
  })
  const hintText = new TextRenderable(renderer, {
    content: "",
    wrapMode: "word",
    selectable: false,
    fg: theme.dim,
    textAlign: "center",
  })
  const keysText = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
    textAlign: "center",
  })

  panel.add(titleText)
  panel.add(detailText)
  panel.add(hintText)
  panel.add(keysText)
  box.add(panel)

  return {
    box,
    show(title, detail, hint, color, retry) {
      panel.borderColor = color
      titleText.fg = color
      titleText.content = title
      detailText.content = detail
      hintText.content = hint
      keysText.content = retry
        ? compose(
            fg(theme.accent)(bold("r")),
            " retry   ",
            fg(theme.accent)(bold("q")),
            " quit",
          )
        : compose(fg(theme.accent)(bold("q")), " quit")
      box.visible = true
    },
    hide() {
      box.visible = false
    },
  }
}

function headerStatus(
  state: DashboardState,
  now: number,
  limited: boolean,
): Array<TextChunk | StyledText> {
  const stale = state.error !== null && state.data !== null
  const offline = state.error !== null && state.data === null

  let main: string
  if (stale && state.lastUpdated !== null) {
    main = `stale · ${formatAgo(now - state.lastUpdated)}`
  } else if (state.loading) {
    main = state.data ? "refreshing…" : "connecting…"
  } else if (offline) {
    main = "offline"
  } else if (state.lastUpdated !== null) {
    main = `updated ${formatAgo(now - state.lastUpdated)}`
  } else {
    main = "connecting…"
  }

  const mainColor = offline ? theme.red : stale ? theme.amber : theme.dim
  const parts: Array<TextChunk | StyledText> = []

  if (state.running > 0) {
    parts.push(
      fg(theme.green)(`● ${state.running} running`),
      fg(theme.dim)(" · "),
    )
  }
  if (limited) {
    parts.push(
      fg(theme.red)(bold("LIMITED")),
      fg(theme.dim)(" · "),
    )
  }
  parts.push(fg(mainColor)(main))
  return parts
}

function errorColor(error: UsageError): string {
  if (
    error.title === "Service authentication failed" ||
    error.title === "Not signed in to OpenCode" ||
    error.title === "No OpenCode Go subscription"
  ) {
    return theme.red
  }
  return theme.amber
}

function compose(...parts: Array<string | TextChunk | StyledText>): StyledText {
  const chunks: TextChunk[] = []
  for (const part of parts) {
    if (typeof part === "string") {
      chunks.push(...stringToStyledText(part).chunks)
    } else if (isStyledText(part)) {
      chunks.push(...part.chunks)
    } else {
      chunks.push(part)
    }
  }
  return new StyledText(chunks)
}
