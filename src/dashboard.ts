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
  formatCount,
  formatDuration,
  formatMetricValue,
  formatPercent,
  formatResetClock,
  formatShort,
  formatTokens,
  meterColor,
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
  StatsData,
  UsageData,
  UsageError,
} from "./service"

export type DashboardState = {
  data: UsageData | null
  stats: StatsData | null
  activity: ActivityData | null
  error: UsageError | null
  statsError: UsageError | null
  activityError: UsageError | null
  metric: Metric
  showActivity: boolean
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
  update(stats: StatsData | null, error: UsageError | null): void
  setWidth(width: number): void
}

type ActivityPanel = {
  box: BoxRenderable
  update(
    activity: ActivityData | null,
    error: UsageError | null,
    metric: Metric,
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
    metric: "cost",
    showActivity: true,
    lastUpdated: null,
    loading: true,
    nextRefreshAt: Date.now(),
  }
  let currentWidth = renderer.width
  let currentHeight = renderer.height
  let activityAttached = false

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
    createMeterCard(renderer, "5-hour window"),
    createMeterCard(renderer, "Weekly"),
    createMeterCard(renderer, "Monthly"),
  ]
  for (const card of cards) cardsRow.add(card.box)

  const statsPanel = createStatsPanel(renderer)
  const activityPanel = createActivityPanel(renderer)
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
    activityPanel.setWidth(contentWidth)
    renderState()
  }

  function renderState(): void {
    const state = currentState
    const now = Date.now()

    const showActivity =
      state.showActivity && currentHeight >= layout.minHeightForActivity
    if (showActivity !== activityAttached) {
      if (showActivity) cardsArea.add(activityPanel.box)
      else cardsArea.remove(activityPanel.box)
      activityAttached = showActivity
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

    statsPanel.update(state.stats, state.statsError)
    activityPanel.update(state.activity, state.activityError, state.metric)

    const retrying = error !== null && !state.loading
    const canOpen = Boolean(data?.workspace.usageURL)
    const isRetry = error !== null && data === null

    const keyParts: Array<string | TextChunk | StyledText> = [
      fg(theme.accent)(bold("r")),
      isRetry ? " retry" : " refresh",
    ]
    if (showActivity) {
      keyParts.push(
        "   ",
        fg(theme.accent)(bold("m")),
        ` ${state.metric}`,
      )
    }
    keyParts.push("   ", fg(theme.accent)(bold("g")), " graph")
    if (canOpen) {
      keyParts.push("   ", fg(theme.accent)(bold("o")), " console")
    }
    keyParts.push("   ", fg(theme.accent)(bold("q")), " quit")
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

function createMeterCard(renderer: CliRenderer, title: string): MeterCard {
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

      box.title = meter.limited ? ` ${title} · LIMITED ` : ` ${title} `
      box.titleColor = color
      box.borderColor = meter.limited ? theme.red : theme.cardBorder

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

function createStatsPanel(renderer: CliRenderer): StatsPanel {
  let panelWidth = 78
  let currentStats: StatsData | null = null
  let currentError: UsageError | null = null

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

  function render(): void {
    if (currentError) {
      box.title = currentStats ? " Usage · stale " : " Usage · unavailable "
      box.titleColor = theme.amber
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
    update(stats, error) {
      currentStats = stats
      currentError = error
      render()
    },
    setWidth(width) {
      panelWidth = Math.max(0, width)
      render()
    },
  }
}

function createActivityPanel(renderer: CliRenderer): ActivityPanel {
  let panelWidth = 78
  let activity: ActivityData | null = null
  let error: UsageError | null = null
  let metric: Metric = "cost"

  const box = new BoxRenderable(renderer, {
    id: "activity",
    height: layout.activityHeight,
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

  const chartRows = Array.from(
    { length: layout.activityChartHeight },
    () =>
      new TextRenderable(renderer, {
        content: "",
        height: 1,
        wrapMode: "none",
        truncate: true,
        selectable: false,
      }),
  )
  for (const row of chartRows) box.add(row)

  function render(): void {
    if (!activity) {
      box.title = error ? " Activity · unavailable " : " Activity "
      box.titleColor = error ? theme.amber : theme.dim
      box.borderColor = error ? theme.amber : theme.cardBorder
      for (const row of chartRows) row.content = ""
      chartRows[chartRows.length - 1]!.content = compose(
        fg(theme.faint)(
          error ? "Activity history unavailable" : "Waiting for activity history",
        ),
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

    const height = layout.activityChartHeight
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

      chartRows[row]!.content = parts.length > 0 ? compose(...parts) : ""
    }

    if (!(max > 0)) {
      chartRows[height - 1]!.content = compose(
        fg(theme.faint)("·".repeat(columns)),
      )
    }

    const spent = formatMetricValue(forecast.spent, metric)
    const projected = formatMetricValue(forecast.projected, metric)
    box.title = ` Activity · ${activity.label} · ${spent} spent · ${projected} forecast${
      error ? " · stale " : " "
    }`
    box.titleColor = error ? theme.amber : theme.dim
    box.borderColor = error ? theme.amber : theme.cardBorder
  }

  render()

  return {
    box,
    update(nextActivity, nextError, nextMetric) {
      activity = nextActivity
      error = nextError
      metric = nextMetric
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

  if (!limited) return [fg(mainColor)(main)]
  return [
    fg(theme.red)(bold("LIMITED")),
    fg(theme.dim)(" · "),
    fg(mainColor)(main),
  ]
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
