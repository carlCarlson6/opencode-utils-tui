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
  formatDuration,
  formatPercent,
  formatResetClock,
  formatShort,
  meterColor,
  remainingPercent,
  renderBar,
  truncateText,
} from "./format"
import { layout, theme } from "./theme"
import type { Meter, UsageData, UsageError } from "./service"

export type DashboardState = {
  data: UsageData | null
  error: UsageError | null
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
    error: null,
    lastUpdated: null,
    loading: true,
    nextRefreshAt: Date.now(),
  }
  let currentWidth = renderer.width
  let currentHeight = renderer.height

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
    const columns = contentWidth >= 96 ? 3 : contentWidth >= 62 ? 2 : 1
    const gap = 1
    const cardWidth = Math.max(
      24,
      Math.floor((contentWidth - gap * (columns - 1)) / columns),
    )

    for (const card of cards) card.setWidth(cardWidth)
    renderState()
  }

  function renderState(): void {
    const state = currentState
    const now = Date.now()
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

    const retrying = error !== null && !state.loading
    const canOpen = Boolean(data?.workspace.usageURL)
    const isRetry = error !== null && data === null

    const keyParts: Array<string | TextChunk | StyledText> = [
      fg(theme.accent)(bold("r")),
      isRetry ? " retry" : " refresh",
    ]
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
    content: "Waiting for usage data",
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
        resetInText.content = "Waiting for usage data"
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
        resetAtText.content = "Waiting for fresh data"
      } else {
        resetInText.content = `Resets in ${formatDuration(meter.resetsAt - now)}`
        resetInText.fg = theme.text
        resetAtText.content = formatResetClock(meter.resetsAt, now)
      }
      resetAtText.fg = theme.dim
    },
  }
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
