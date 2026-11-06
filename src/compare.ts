import {
  BoxRenderable,
  CliRenderEvents,
  StyledText,
  TextAttributes,
  TextRenderable,
  bg,
  bold,
  createCliRenderer,
  fg,
  isStyledText,
  stringToStyledText,
  type CliRenderer,
  type TextChunk,
} from "@opentui/core"
import {
  loadCatalog,
  cacheDirectory,
  filterModels,
  parseBenchmarkList,
  sortModels,
  SORT_KEYS,
  SORT_LABELS,
  CatalogError,
  type Benchmark,
  type Catalog,
  type Cost,
  type ModelRecord,
  type SortKey,
} from "./catalog"
import {
  formatAgo,
  formatCostPerRequest,
  formatCount,
  truncateText,
} from "./format"
import { theme } from "./theme"

const VERSION = "0.1.0"
const MAX_SELECTED = 4
const MIN_WIDTH = 80
const MIN_HEIGHT = 22
const ENRICH_TIMEOUT_MS = 8_000
const TICK_MS = 1_000
const PALETTE = [theme.accent, theme.green, theme.amber, theme.violet] as const

type Focus = "list" | "table"

type OpenCodeUsage = {
  tokens: number | undefined
  sharePercent: number | undefined
  rankLastWeek: number | undefined
  uniqueUsers: number | undefined
  weeklyRetentionPercent: number | undefined
  costPerSessionUsd: number | undefined
}

type Enrichment = {
  status: "loading" | "ready" | "error"
  usage?: OpenCodeUsage
  benchmarks?: Benchmark[]
  price?: Cost
}

type CompareState = {
  catalog: Catalog | null
  loading: boolean
  error: CatalogError | null
  query: string
  searching: boolean
  sort: SortKey
  cursor: number
  listOffset: number
  selected: string[]
  focus: Focus
  tableOffset: number
  enrichment: Map<string, Enrichment>
  lastUpdated: number | null
  notice: { text: string; until: number } | null
}

type CellTone = "yes" | "no" | "muted" | undefined

type Cell = {
  text: string
  value?: number
  tone?: CellTone
  best?: boolean
}

type TableRow =
  | { kind: "section"; label: string }
  | { kind: "data"; label: string; align: "left" | "right"; cells: Cell[] }
  | { kind: "info"; label: string }

type CompareView = {
  update(state: CompareState): void
  reflow(width: number, height: number): void
  setVisible(visible: boolean): void
  destroy(): void
}

export type CompareKey = {
  name: string
  sequence: string
  ctrl: boolean
  meta: boolean
  eventType: string
}

export type CompareKeyResult = "handled" | "exit" | "quit"

export type CompareSessionOptions = {
  offline?: boolean
  noCache?: boolean
  embedded?: boolean
}

export type CompareSession = {
  activate(): void
  deactivate(): void
  reflow(width: number, height: number): void
  handleKey(key: CompareKey): CompareKeyResult
  tick(): void
  destroy(): void
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)

  if (hasFlag(args, "--help", "-h")) {
    printHelp()
    return
  }

  if (hasFlag(args, "--version", "-v")) {
    console.log(`oc-compare ${VERSION}`)
    return
  }

  const offline = hasFlag(args, "--offline")
  const noCache = hasFlag(args, "--no-cache")

  if (hasFlag(args, "--check")) {
    try {
      const catalog = await loadCatalog({ offline, force: noCache })
      printCheck(catalog)
    } catch (error) {
      const failure = toCatalogError(error)
      console.error(`${failure.title}: ${failure.detail}`)
      process.exitCode = 1
    }
    return
  }

  if (!process.stdout.isTTY) {
    console.error("oc-compare must run in an interactive terminal.")
    process.exitCode = 1
    return
  }

  let renderer: CliRenderer
  try {
    renderer = await createRenderer()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`Could not start the TUI: ${message}`)
    process.exitCode = 1
    return
  }

  await run(renderer, { offline, noCache })
}

export function createCompareSession(
  renderer: CliRenderer,
  options: CompareSessionOptions = {},
): CompareSession {
  let state: CompareState = emptyState()
  const view = createView(renderer, options.embedded === true)
  let refreshing = false
  let shuttingDown = false
  let active = false
  let started = false
  const enriching = new Set<string>()

  const render = (): void => view.update(state)

  const setNotice = (text: string): void => {
    state = {
      ...state,
      notice: { text, until: Date.now() + 2_500 },
    }
    render()
  }

  const visible = (): ModelRecord[] => visibleModels(state)

  const toggleSelection = (): void => {
    const models = visible()
    const model = models[state.cursor]
    if (!model) return

    if (state.selected.includes(model.id)) {
      state = {
        ...state,
        selected: state.selected.filter((id) => id !== model.id),
        tableOffset: 0,
      }
      render()
      return
    }

    if (state.selected.length >= MAX_SELECTED) {
      setNotice(`Max ${MAX_SELECTED}`)
      return
    }

    state = {
      ...state,
      selected: [...state.selected, model.id],
      tableOffset: 0,
    }
    render()
    void enrich(model.id)
  }

  const moveSelection = (delta: number): void => {
    if (state.focus === "table") {
      const visibleRows = tableDataRows(renderer.height)
      const max = maxTableOffset(state, visibleRows)
      state = {
        ...state,
        tableOffset: clamp(state.tableOffset + delta, 0, max),
      }
      render()
      return
    }

    const models = visible()
    if (models.length === 0) return

    const rows = listViewportRows(renderer.height)
    const cursor = clamp(state.cursor + delta, 0, models.length - 1)
    let offset = clamp(
      state.listOffset,
      0,
      Math.max(0, models.length - rows),
    )
    if (cursor < offset) offset = cursor
    else if (cursor >= offset + rows) offset = cursor - rows + 1
    offset = clamp(offset, 0, Math.max(0, models.length - rows))

    state = {
      ...state,
      cursor,
      listOffset: offset,
      tableOffset: state.selected.length === 0 ? 0 : state.tableOffset,
    }
    render()
  }

  const jump = (to: "start" | "end"): void => {
    if (state.focus === "table") {
      const visibleRows = tableDataRows(renderer.height)
      const max = maxTableOffset(state, visibleRows)
      state = {
        ...state,
        tableOffset: to === "start" ? 0 : max,
      }
      render()
      return
    }

    const models = visible()
    if (models.length === 0) return
    const rows = listViewportRows(renderer.height)
    const cursor = to === "start" ? 0 : models.length - 1
    const offset =
      to === "start" ? 0 : Math.max(0, models.length - rows)
    state = {
      ...state,
      cursor,
      listOffset: offset,
      tableOffset: state.selected.length === 0 ? 0 : state.tableOffset,
    }
    render()
  }

  const cycleSort = (): void => {
    const index = SORT_KEYS.indexOf(state.sort)
    const next = SORT_KEYS[(index + 1) % SORT_KEYS.length] ?? "newest"
    state = {
      ...state,
      sort: next,
      cursor: 0,
      listOffset: 0,
      tableOffset: 0,
    }
    render()
  }

  const enrich = async (id: string): Promise<void> => {
    if (shuttingDown || enriching.has(id)) return

    const current = state.enrichment.get(id)
    if (current && current.status !== "error") return

    enriching.add(id)
    state.enrichment.set(id, { status: "loading" })
    render()

    try {
      const url = openCodeDataUrl(id)
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": `oc-compare/${VERSION}`,
        },
        signal: AbortSignal.timeout(ENRICH_TIMEOUT_MS),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)

      const body: unknown = await response.json()
      if (shuttingDown) return
      const parsed = parseEnrichment(body)
      state.enrichment.set(id, { status: "ready", ...parsed })
    } catch {
      if (!shuttingDown) {
        state.enrichment.set(id, { status: "error" })
      }
    } finally {
      enriching.delete(id)
      if (!shuttingDown) render()
    }
  }

  const load = async (force: boolean): Promise<void> => {
    if (refreshing || shuttingDown) return

    refreshing = true
    state = { ...state, loading: true }
    render()

    try {
      const catalog = await loadCatalog({
        force,
        offline: options.offline ?? false,
      })
      if (shuttingDown) return
      const models = visibleModels({ ...state, catalog })
      const cursor = clamp(state.cursor, 0, Math.max(0, models.length - 1))
      const available = new Set(catalog.models.map((model) => model.id))
      const selected = state.selected.filter((id) => available.has(id))
      const enrichment = new Map(state.enrichment)
      for (const [id, item] of enrichment) {
        if (item.status === "error") enrichment.delete(id)
      }

      state = {
        ...state,
        catalog,
        loading: false,
        error: null,
        lastUpdated: catalog.fetchedAt,
        cursor,
        selected,
        enrichment,
      }
      render()

      for (const id of state.selected) void enrich(id)
    } catch (error) {
      if (shuttingDown) return
      state = {
        ...state,
        loading: false,
        error: toCatalogError(error),
      }
      render()
    } finally {
      refreshing = false
    }
  }

  const handleKey = (key: CompareKey): CompareKeyResult => {
    if (key.eventType === "release") return "handled"
    const name = key.name.toLowerCase()

    if (state.searching) {
      if (name === "escape") {
        state = {
          ...state,
          searching: false,
          query: "",
          cursor: 0,
          listOffset: 0,
        }
        render()
        return "handled"
      }
      if (name === "return" || name === "enter") {
        state = { ...state, searching: false }
        render()
        return "handled"
      }
      if (name === "backspace") {
        if (state.query.length === 0) {
          state = {
            ...state,
            searching: false,
            cursor: 0,
            listOffset: 0,
          }
        } else {
          state = {
            ...state,
            query: [...state.query].slice(0, -1).join(""),
            cursor: 0,
            listOffset: 0,
          }
        }
        render()
        return "handled"
      }
      if (isPrintable(key)) {
        state = {
          ...state,
          query: state.query + key.sequence,
          cursor: 0,
          listOffset: 0,
        }
        render()
        return "handled"
      }

      if (
        !["up", "down", "pageup", "pagedown", "home", "end", "tab"].includes(
          name,
        )
      ) {
        return "handled"
      }
    }

    if (name === "escape") {
      return options.embedded === true ? "exit" : "handled"
    }
    if (options.embedded === true && name === "c") return "exit"
    if (name === "q") return "quit"
    if (name === "tab") {
      state = {
        ...state,
        searching: false,
        focus: state.focus === "list" ? "table" : "list",
      }
      render()
      return "handled"
    }
    if (name === "/") {
      state = {
        ...state,
        searching: true,
        query: "",
        cursor: 0,
        listOffset: 0,
        tableOffset: 0,
        focus: "list",
      }
      render()
      return "handled"
    }
    if (name === "r") {
      void load(true)
      return "handled"
    }
    if (name === "s") {
      cycleSort()
      return "handled"
    }
    if (name === "x") {
      if (state.selected.length === 0) return "handled"
      state = { ...state, selected: [], tableOffset: 0 }
      render()
      return "handled"
    }
    if (name === "space" || name === "return" || name === "enter") {
      if (state.focus === "list") toggleSelection()
      return "handled"
    }
    if (name === "up" || name === "k") {
      moveSelection(-1)
      return "handled"
    }
    if (name === "down" || name === "j") {
      moveSelection(1)
      return "handled"
    }
    if (name === "pageup") {
      moveSelection(-pageSize(renderer.height))
      return "handled"
    }
    if (name === "pagedown") {
      moveSelection(pageSize(renderer.height))
      return "handled"
    }
    if (name === "home") {
      jump("start")
      return "handled"
    }
    if (name === "end") {
      jump("end")
    }
    return "handled"
  }

  return {
    activate() {
      active = true
      view.setVisible(true)
      view.reflow(renderer.width, renderer.height)
      render()
      if (!started) {
        started = true
        void load(options.noCache ?? false)
      }
    },
    deactivate() {
      active = false
      view.setVisible(false)
    },
    reflow(width, height) {
      view.reflow(width, height)
    },
    handleKey,
    tick() {
      if (state.notice && Date.now() > state.notice.until) {
        state = { ...state, notice: null }
      }
      if (active) render()
    },
    destroy() {
      shuttingDown = true
      view.destroy()
    },
  }
}

async function run(
  renderer: CliRenderer,
  options: { offline: boolean; noCache: boolean },
): Promise<void> {
  const session = createCompareSession(renderer, options)
  let tickTimer: ReturnType<typeof setInterval> | null = null
  let shuttingDown = false

  const resizeHandler = (width: number, height: number): void => {
    session.reflow(width, height)
  }

  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true

    if (tickTimer) {
      clearInterval(tickTimer)
      tickTimer = null
    }

    renderer.off(CliRenderEvents.RESIZE, resizeHandler)
    session.destroy()
    renderer.destroy()
    try {
      await renderer.closed
    } finally {
      process.exit(0)
    }
  }

  renderer.on(CliRenderEvents.RESIZE, resizeHandler)
  renderer.keyInput.on("keypress", (key) => {
    if (key.eventType === "release") return
    const result = session.handleKey(key)
    if (result === "quit" || result === "exit") void shutdown()
  })

  tickTimer = setInterval(() => session.tick(), TICK_MS)
  session.activate()
}

async function createRenderer(): Promise<CliRenderer> {
  return createCliRenderer({
    exitOnCtrlC: true,
    exitSignals: ["SIGINT", "SIGTERM"],
    backgroundColor: theme.background,
  })
}

function createView(
  renderer: CliRenderer,
  embedded = false,
): CompareView {
  let state: CompareState = emptyState()
  let width = renderer.width
  let height = renderer.height

  const root = new BoxRenderable(renderer, {
    id: "compare",
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 20,
    flexDirection: "column",
    gap: 1,
    padding: 1,
    backgroundColor: theme.background,
    visible: false,
  })
  renderer.root.add(root)

  const header = new BoxRenderable(renderer, {
    id: "compare-header",
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

  const body = new BoxRenderable(renderer, {
    id: "compare-body",
    flexGrow: 1,
    minHeight: 0,
    flexDirection: "row",
    gap: 1,
  })
  root.add(body)

  const listPanel = new BoxRenderable(renderer, {
    id: "compare-list",
    flexDirection: "column",
    flexShrink: 0,
    border: true,
    borderStyle: "rounded",
    borderColor: theme.cardBorder,
    title: " Models ",
    titleColor: theme.dim,
    titleAlignment: "left",
    backgroundColor: theme.card,
    paddingLeft: 1,
    paddingRight: 1,
  })
  const searchRow = new TextRenderable(renderer, {
    content: "",
    height: 1,
    wrapMode: "none",
    truncate: true,
    selectable: false,
  })
  listPanel.add(searchRow)
  body.add(listPanel)

  const tablePanel = new BoxRenderable(renderer, {
    id: "compare-table",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    border: true,
    borderStyle: "rounded",
    borderColor: theme.cardBorder,
    title: " Compare ",
    titleColor: theme.dim,
    titleAlignment: "left",
    backgroundColor: theme.card,
    paddingLeft: 1,
    paddingRight: 1,
  })
  body.add(tablePanel)

  const footer = new BoxRenderable(renderer, {
    id: "compare-footer",
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

  const listRows: TextRenderable[] = []
  const tableRows: TextRenderable[] = []

  function reflow(nextWidth: number, nextHeight: number): void {
    width = nextWidth
    height = nextHeight

    const contentWidth = Math.max(0, width - 2)
    let listWidth = clamp(Math.round(contentWidth * 0.4), 34, 58)
    if (contentWidth - listWidth - 1 < 38) {
      listWidth = Math.max(28, contentWidth - 39)
    }
    listPanel.width = listWidth
    render()
  }

  function render(): void {
    const models = visibleModels(state)
    const selected = selectedModels(state)
    const table = tableModels(state)
    const cursor =
      models.length === 0 ? 0 : clamp(state.cursor, 0, models.length - 1)
    const chatCount = state.catalog
      ? state.catalog.models.filter((model) => model.type === "chat").length
      : 0
    const contentWidth = Math.max(0, width - 2)
    const listWidth = listPanel.width
    const tableWidth = Math.max(0, contentWidth - listWidth - 1)
    const listInner = Math.max(1, listWidth - 4)
    const tableInner = Math.max(1, tableWidth - 4)
    const listVisible = listViewportRows(height)
    const tableVisible = tableDataRows(height)

    syncRows(listPanel, listRows, listVisible, renderer)
    syncRows(tablePanel, tableRows, tableVisible + 1, renderer)

    headerLeft.content = compose(
      fg(theme.accent)(bold("◆ oc-compare")),
      fg(theme.dim)(" · model comparison"),
    )
    headerRight.content = state.catalog
      ? compose(
          fg(theme.dim)(`${formatCount(chatCount)} chat models`),
          fg(theme.dim)(" · "),
          fg(theme.accent)(`${state.selected.length}/${MAX_SELECTED} picked`),
        )
      : compose(fg(theme.dim)("models.dev"))

    const picked =
      state.selected.length > 0
        ? ` · ${state.selected.length} picked`
        : ""
    const sortLabel =
      listWidth >= 40 || state.selected.length === 0
        ? ` · ${SORT_LABELS[state.sort]}`
        : ""
    const listTitle = state.catalog
      ? ` Models · ${formatCount(models.length)}${state.query ? `/${formatCount(chatCount)}` : ""}${sortLabel}${picked} `
      : " Models "
    listPanel.title = listTitle
    listPanel.titleColor = state.focus === "list" ? theme.accent : theme.dim
    listPanel.borderColor =
      state.focus === "list" ? theme.accent : theme.cardBorder

    const dataRows = buildTableRows(state)
    const maxOffset = Math.max(0, dataRows.length - tableVisible)
    const tableOffset =
      state.selected.length === 0 && state.focus === "list"
        ? 0
        : clamp(state.tableOffset, 0, maxOffset)
    const rangeStart = dataRows.length === 0 ? 0 : tableOffset + 1
    const rangeEnd = Math.min(tableOffset + tableVisible, dataRows.length)
    const preview = selected.length === 0 ? table[0] : undefined
    tablePanel.title = preview
      ? ` Preview · ${truncateText(preview.name, 24)}${dataRows.length > 0 ? ` · ${rangeStart}-${rangeEnd}/${dataRows.length}` : ""} `
      : selected.length === 0
        ? " Compare "
        : ` Compare · ${selected.length} selected${dataRows.length > 0 ? ` · ${rangeStart}-${rangeEnd}/${dataRows.length}` : ""} `
    tablePanel.titleColor = state.focus === "table" ? theme.accent : theme.dim
    tablePanel.borderColor =
      state.focus === "table" ? theme.accent : theme.cardBorder

    renderSearch(models.length)
    renderList(models, cursor, listVisible, listInner)
    renderTable(
      table,
      dataRows,
      tableOffset,
      tableVisible,
      tableInner,
    )

    const compact = width < 96
    const keys: Array<string | TextChunk | StyledText> = [
      fg(theme.accent)(bold("↑↓")),
      " move  ",
      fg(theme.accent)(bold("space")),
      " pick  ",
      fg(theme.accent)(bold("/")),
      compact ? " find  " : " search  ",
      ...(compact
        ? []
        : [fg(theme.accent)(bold("s")), " sort  "]),
      fg(theme.accent)(bold("tab")),
      ` ${state.focus === "list" ? "table" : "list"}  `,
      ...(state.selected.length > 0
        ? [fg(theme.accent)(bold("x")), " clear  "]
        : []),
    ]

    if (embedded) {
      keys.push(fg(theme.accent)(bold("esc")), " back  ")
    }
    if (!(compact && embedded)) {
      keys.push(fg(theme.accent)(bold("r")), " refresh  ")
    }
    keys.push(fg(theme.accent)(bold("q")), " quit")

    footerLeft.content = compose(...keys)

    const status = footerStatus(state, compact)
    footerRight.fg = status.color
    footerRight.content = status.text

    const tooSmall = width < MIN_WIDTH || height < MIN_HEIGHT
    if (tooSmall) {
      overlay.show(
        "Terminal too small",
        `Need at least ${MIN_WIDTH}x${MIN_HEIGHT}. Current size: ${width}x${height}.`,
        "Resize the terminal or press q.",
        theme.amber,
      )
    } else if (state.error && !state.catalog) {
      overlay.show(
        state.error.title,
        state.error.detail,
        state.loading
          ? "Retrying now…"
          : (state.error.hint ?? "Press r to retry."),
        theme.amber,
      )
    } else {
      overlay.hide()
    }

    renderer.requestRender()
  }

  function renderSearch(matchCount: number): void {
    if (state.searching) {
      searchRow.content = compose(
        fg(theme.accent)(bold("/")),
        fg(theme.text)(state.query),
        fg(theme.accent)("█"),
        fg(theme.faint)("  enter keep · esc clear"),
      )
      return
    }

    if (state.query) {
      const inner = Math.max(1, listPanel.width - 4)
      const base = `filter ${state.query}`
      const extra = ` · ${formatCount(matchCount)} · /`
      searchRow.content = compose(
        fg(theme.faint)("filter "),
        fg(theme.text)(state.query),
        fg(theme.faint)(
          base.length + extra.length <= inner ? extra : "",
        ),
      )
      return
    }

    const hint =
      listPanel.width - 4 >= 42
        ? "/ search models · space select · tab table"
        : "/ search · space pick"
    searchRow.content = compose(fg(theme.faint)(hint))
  }

  function renderList(
    models: ModelRecord[],
    cursor: number,
    visibleRows: number,
    inner: number,
  ): void {
    if (!state.catalog) {
      listRows.forEach((row, index) => {
        row.content =
          index === 0
            ? compose(
                fg(theme.faint)(
                  state.loading ? "Loading catalog…" : "No catalog",
                ),
              )
            : ""
      })
      return
    }

    if (models.length === 0) {
      listRows.forEach((row, index) => {
        row.content =
          index === 0
            ? compose(fg(theme.faint)("No models match the filter"))
            : ""
      })
      return
    }

    const maxOffset = Math.max(0, models.length - visibleRows)
    const start = clamp(state.listOffset, 0, maxOffset)
    const nameWidth = Math.max(6, inner - 17)

    for (let index = 0; index < visibleRows; index++) {
      const model = models[start + index]
      const row = listRows[index]
      if (!row) continue

      if (!model) {
        row.content = ""
        continue
      }

      const isCursor = start + index === cursor
      const selectionIndex = state.selected.indexOf(model.id)
      const isSelected = selectionIndex >= 0
      const price = formatPriceShort(model.cost?.input)
      const context = formatContextShort(model.context)
      const name = truncateText(model.name, nameWidth)

      row.content = compose(
        paint(theme.accent, isCursor ? "▸" : " ", isCursor),
        paint(
          theme.green,
          isSelected ? String(selectionIndex + 1) : " ",
          isCursor,
        ),
        paint(theme.text, " ", isCursor),
        paint(
          isSelected || isCursor ? theme.text : theme.dim,
          name.padEnd(nameWidth),
          isCursor,
          isSelected || isCursor,
        ),
        paint(theme.text, " ", isCursor),
        paint(theme.dim, price.padStart(7), isCursor),
        paint(theme.text, " ", isCursor),
        paint(theme.dim, context.padStart(4), isCursor),
      )
    }
  }

  function renderTable(
    columns: ModelRecord[],
    rows: TableRow[],
    offset: number,
    visibleRows: number,
    inner: number,
  ): void {
    if (tableRows.length === 0) return

    const header = tableRows[0]
    if (!header) return

    if (columns.length === 0) {
      header.content = ""
    } else {
      const layout = tableLayout(inner, columns.length)
      const preview = state.selected.length === 0
      const parts: Array<string | TextChunk | StyledText> = [
        paint(theme.dim, "".padEnd(layout.labelWidth), false),
      ]

      columns.forEach((model, index) => {
        const color = PALETTE[index % PALETTE.length] ?? theme.accent
        const label = preview
          ? `Preview · ${model.name}`
          : `#${index + 1} ${model.name}`
        parts.push(
          paint(
            color,
            truncateText(label, layout.columnWidth).padEnd(
              layout.columnWidth,
            ),
            false,
            true,
          ),
        )
        if (index < columns.length - 1) {
          parts.push(paint(theme.text, " ".repeat(layout.gap), false))
        }
      })

      header.content = compose(...parts)
    }

    const maxOffset = Math.max(0, rows.length - visibleRows)
    const start = clamp(offset, 0, maxOffset)

    for (let index = 0; index < visibleRows; index++) {
      const row = tableRows[index + 1]
      const data = rows[start + index]
      if (!row) continue
      if (!data) {
        row.content = ""
        continue
      }

      if (data.kind === "section") {
        row.content = compose(
          fg(theme.accent)(bold(data.label)),
        )
        continue
      }

      if (data.kind === "info") {
        row.content = compose(
          fg(
            data.label.startsWith("Loading")
              ? theme.amber
              : theme.faint,
          )(data.label),
        )
        continue
      }

      const layout = tableLayout(inner, columns.length)
      const parts: Array<string | TextChunk | StyledText> = [
        paint(
          theme.dim,
          truncateText(data.label, layout.labelWidth).padEnd(
            layout.labelWidth,
          ),
          false,
        ),
      ]

      data.cells.forEach((cell, index) => {
        const text = truncateText(
          cell.text,
          layout.columnWidth,
        )
        const padded =
          data.align === "right"
            ? text.padStart(layout.columnWidth)
            : text.padEnd(layout.columnWidth)
        const color = cell.best
          ? theme.green
          : cell.tone === "yes"
            ? theme.green
            : cell.tone === "no"
              ? theme.dim
              : cell.tone === "muted"
                ? theme.faint
                : theme.text
        parts.push(
          paint(
            color,
            padded,
            false,
            cell.best === true,
          ),
        )
        if (index < data.cells.length - 1) {
          parts.push(paint(theme.text, " ".repeat(layout.gap), false))
        }
      })

      row.content = compose(...parts)
    }
  }

  return {
    update(next) {
      state = next
      render()
    },
    reflow,
    setVisible(visible) {
      root.visible = visible
    },
    destroy() {
      // The renderer owns the renderables; nothing else to release here.
    },
  }

  function syncRows(
    panel: BoxRenderable,
    rows: TextRenderable[],
    count: number,
    renderContext: CliRenderer,
  ): void {
    while (rows.length < count) {
      const row = new TextRenderable(renderContext, {
        content: "",
        height: 1,
        wrapMode: "none",
        truncate: true,
        selectable: false,
      })
      panel.add(row)
      rows.push(row)
    }
    while (rows.length > count) {
      const row = rows.pop()
      if (row) panel.remove(row)
    }
  }
}

function createOverlay(
  renderer: CliRenderer,
): { box: BoxRenderable; show: (title: string, detail: string, hint: string, color: string) => void; hide: () => void } {
  const box = new BoxRenderable(renderer, {
    id: "compare-overlay",
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
    id: "compare-overlay-panel",
    width: "80%",
    maxWidth: 76,
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
    fg: theme.dim,
  })

  panel.add(titleText)
  panel.add(detailText)
  panel.add(hintText)
  panel.add(keysText)
  box.add(panel)

  return {
    box,
    show(title, detail, hint, color) {
      panel.borderColor = color
      titleText.fg = color
      titleText.content = title
      detailText.content = detail
      hintText.content = hint
      keysText.content = compose(
        fg(theme.accent)(bold("r")),
        " retry   ",
        fg(theme.accent)(bold("q")),
        " quit",
      )
      box.visible = true
    },
    hide() {
      box.visible = false
    },
  }
}

function emptyState(): CompareState {
  return {
    catalog: null,
    loading: true,
    error: null,
    query: "",
    searching: false,
    sort: "newest",
    cursor: 0,
    listOffset: 0,
    selected: [],
    focus: "list",
    tableOffset: 0,
    enrichment: new Map(),
    lastUpdated: null,
    notice: null,
  }
}

function visibleModels(state: CompareState): ModelRecord[] {
  if (!state.catalog) return []
  const chat = state.catalog.models.filter((model) => model.type === "chat")
  return sortModels(filterModels(chat, state.query), state.sort)
}

function selectedModels(state: CompareState): ModelRecord[] {
  if (!state.catalog) return []
  const byID = new Map(
    state.catalog.models.map((model) => [model.id, model]),
  )
  return state.selected
    .map((id) => byID.get(id))
    .filter((model): model is ModelRecord => model !== undefined)
}

function previewModel(state: CompareState): ModelRecord | undefined {
  const models = visibleModels(state)
  if (models.length === 0) return undefined
  return models[clamp(state.cursor, 0, models.length - 1)]
}

function tableModels(state: CompareState): ModelRecord[] {
  const selected = selectedModels(state)
  if (selected.length > 0) return selected
  const preview = previewModel(state)
  return preview ? [preview] : []
}

function buildTableRows(state: CompareState): TableRow[] {
  const models = tableModels(state)
  if (models.length === 0) {
    if (!state.catalog) {
      return [
        {
          kind: "info",
          label: state.loading
            ? "Loading model catalog…"
            : "No model catalog.",
        },
      ]
    }
    return [
      { kind: "info", label: "No models match the filter." },
      { kind: "info", label: "Press / to change the search." },
      { kind: "info", label: "" },
      { kind: "info", label: "Data: models.dev · opencode.ai/data" },
    ]
  }

  const enrichments = models.map((model) =>
    state.enrichment.get(model.id),
  )
  const rows: TableRow[] = []
  const pushSection = (label: string): void => {
    rows.push({ kind: "section", label })
  }
  const pushData = (
    label: string,
    cells: Cell[],
    align: "left" | "right",
    better?: "lower" | "higher",
  ): void => {
    let best: number | undefined
    let numericCount = 0
    if (better) {
      for (const cell of cells) {
        if (cell.value === undefined) continue
        numericCount += 1
        if (
          best === undefined ||
          (better === "lower" ? cell.value < best : cell.value > best)
        ) {
          best = cell.value
        }
      }
    }
    const highlight = numericCount > 1
    rows.push({
      kind: "data",
      label,
      align,
      cells: cells.map((cell) => ({
        ...cell,
        best:
          highlight &&
          best !== undefined &&
          cell.value !== undefined &&
          cell.value === best,
      })),
    })
  }

  pushSection("PRICE · USD / 1M TOKENS")
  pushData(
    "Input",
    models.map((model, index) =>
      priceCell(effectivePrice(model, enrichments[index])?.input),
    ),
    "right",
    "lower",
  )
  pushData(
    "Output",
    models.map((model, index) =>
      priceCell(effectivePrice(model, enrichments[index])?.output),
    ),
    "right",
    "lower",
  )
  pushData(
    "Cache read",
    models.map((model, index) =>
      priceCell(effectivePrice(model, enrichments[index])?.cacheRead),
    ),
    "right",
    "lower",
  )
  pushData(
    "Cache write",
    models.map((model, index) =>
      priceCell(effectivePrice(model, enrichments[index])?.cacheWrite),
    ),
    "right",
    "lower",
  )
  if (models.length <= 2) {
    pushData(
      "Price from",
      models.map((model, index) =>
        textCell(effectivePriceSource(model, enrichments[index])),
      ),
      "left",
    )
  }

  pushSection("LIMITS")
  pushData(
    "Context",
    models.map((model) => numericCell(model.context, formatContext)),
    "right",
    "higher",
  )
  pushData(
    "Max output",
    models.map((model) =>
      numericCell(model.maxOutput, formatContext),
    ),
    "right",
    "higher",
  )

  const benchmarkModels = models.map((model, index) =>
    benchmarkMap(benchmarksFor(model, enrichments[index])),
  )
  const benchmarks = collectBenchmarks(models, enrichments)

  pushSection(`BENCHMARKS · ${benchmarks.length}`)
  if (benchmarks.length === 0) {
    rows.push({
      kind: "info",
      label: "No benchmarks for these models.",
    })
  } else {
    for (const benchmark of benchmarks) {
      pushData(
        benchmark.label,
        benchmarkModels.map((map) => {
          const value = map.get(benchmark.key)
          return value
            ? {
                text: formatBenchmarkScore(value),
                value: value.score,
              }
            : textCell("—", "muted")
        }),
        "right",
        "higher",
      )
    }
  }

  pushSection("CAPABILITIES")
  pushData(
    "Reasoning",
    models.map((model) => booleanCell(model.reasoning)),
    "left",
  )
  pushData(
    "Tool calls",
    models.map((model) => booleanCell(model.toolCall)),
    "left",
  )
  pushData(
    "Structured",
    models.map((model) => booleanCell(model.structuredOutput)),
    "left",
  )
  pushData(
    "Inputs",
    models.map((model) =>
      textCell(model.modalities.input.join(", ") || "—"),
    ),
    "left",
  )
  pushData(
    "Open weights",
    models.map((model) => booleanCell(model.openWeights)),
    "left",
  )

  pushSection("MODEL")
  pushData(
    "Lab",
    models.map((model) => textCell(model.labName)),
    "left",
  )
  pushData(
    "Released",
    models.map((model) => textCell(model.releaseDate ?? "—")),
    "left",
  )
  pushData(
    "Knowledge",
    models.map((model) => textCell(model.knowledge ?? "—")),
    "left",
  )

  const usages = enrichments.map((enrichment) =>
    enrichment?.status === "ready" ? enrichment.usage : undefined,
  )
  if (usages.some((usage) => usage !== undefined)) {
    pushSection("OPENCODE USAGE · LAST 2 MONTHS")
    pushData(
      "Tokens",
      usages.map((usage) =>
        usage?.tokens !== undefined
          ? numericCell(usage.tokens, formatTokensCompact)
          : textCell("—", "muted"),
      ),
      "right",
      "higher",
    )
    pushData(
      "Share",
      usages.map((usage) =>
        usage?.sharePercent !== undefined
          ? numericCell(usage.sharePercent, formatPercentValue)
          : textCell("—", "muted"),
      ),
      "right",
      "higher",
    )
    pushData(
      "Rank last week",
      usages.map((usage) =>
        usage?.rankLastWeek !== undefined
          ? numericCell(usage.rankLastWeek, formatRank)
          : textCell("—", "muted"),
      ),
      "right",
      "lower",
    )
    pushData(
      "Unique users",
      usages.map((usage) =>
        usage?.uniqueUsers !== undefined
          ? numericCell(usage.uniqueUsers, formatTokensCompact)
          : textCell("—", "muted"),
      ),
      "right",
      "higher",
    )
    pushData(
      "Weekly retention",
      usages.map((usage) =>
        usage?.weeklyRetentionPercent !== undefined
          ? numericCell(
              usage.weeklyRetentionPercent,
              formatPercentValue,
            )
          : textCell("—", "muted"),
      ),
      "right",
      "higher",
    )
    pushData(
      "Cost / session",
      usages.map((usage) =>
        usage?.costPerSessionUsd !== undefined
          ? numericCell(
              usage.costPerSessionUsd,
              formatCostPerRequest,
            )
          : textCell("—", "muted"),
      ),
      "right",
      "lower",
    )
  } else if (
    enrichments.some((enrichment) => enrichment?.status === "loading")
  ) {
    rows.push({ kind: "info", label: "Loading OpenCode usage…" })
  }

  return rows
}

function effectivePrice(
  model: ModelRecord,
  enrichment: Enrichment | undefined,
): Cost | null {
  if (
    enrichment?.status === "ready" &&
    enrichment.price &&
    (enrichment.price.input !== undefined ||
      enrichment.price.output !== undefined)
  ) {
    return enrichment.price
  }
  return model.cost
}

function effectivePriceSource(
  model: ModelRecord,
  enrichment: Enrichment | undefined,
): string {
  if (
    enrichment?.status === "ready" &&
    enrichment.price &&
    (enrichment.price.input !== undefined ||
      enrichment.price.output !== undefined)
  ) {
    return "OpenCode Data"
  }
  return model.priceSource ?? "—"
}

function benchmarksFor(
  model: ModelRecord,
  enrichment: Enrichment | undefined,
): Benchmark[] {
  const extra =
    enrichment?.status === "ready" ? (enrichment.benchmarks ?? []) : []
  if (extra.length === 0) return model.benchmarks

  const merged = new Map<string, Benchmark>()
  for (const benchmark of extra) {
    merged.set(benchmarkKey(benchmark), benchmark)
  }
  for (const benchmark of model.benchmarks) {
    const key = benchmarkKey(benchmark)
    if (!merged.has(key)) merged.set(key, benchmark)
  }
  return [...merged.values()]
}

function collectBenchmarks(
  models: ModelRecord[],
  enrichments: Array<Enrichment | undefined>,
): Array<{ key: string; label: string }> {
  const meta = new Map<
    string,
    { key: string; label: string; count: number; order: number }
  >()
  let order = 0

  models.forEach((model, index) => {
    const seen = new Set<string>()
    for (const benchmark of benchmarksFor(model, enrichments[index])) {
      const key = benchmarkKey(benchmark)
      if (seen.has(key)) continue
      seen.add(key)

      let item = meta.get(key)
      if (!item) {
        item = {
          key,
          label: benchmarkLabel(benchmark),
          count: 0,
          order: order++,
        }
        meta.set(key, item)
      }
      item.count += 1
    }
  })

  return [...meta.values()]
    .sort((a, b) => b.count - a.count || a.order - b.order)
    .map(({ key, label }) => ({ key, label }))
}

function benchmarkMap(
  benchmarks: Benchmark[],
): Map<string, Benchmark> {
  return new Map(
    benchmarks.map((benchmark) => [benchmarkKey(benchmark), benchmark]),
  )
}

function benchmarkKey(benchmark: Benchmark): string {
  return `${benchmark.name}\u0000${benchmark.variant ?? ""}`
}

function benchmarkLabel(benchmark: Benchmark): string {
  const parts = [benchmark.name]
  if (benchmark.variant) parts.push(benchmark.variant)
  if (benchmark.version && !benchmark.name.includes(benchmark.version)) {
    parts.push(
      benchmark.version.toLowerCase().startsWith("v")
        ? benchmark.version
        : `v${benchmark.version}`,
    )
  }
  return parts.join(" · ")
}

function formatBenchmarkScore(benchmark: Benchmark): string {
  const metric = (benchmark.metric ?? "").toLowerCase()
  const percent =
    /percent|resolve|rate|accuracy|pass|score/.test(metric) &&
    !/elo/.test(metric)
  let value = benchmark.score
  if (percent && value > 0 && value <= 1) value *= 100
  return percent ? `${formatNumber(value)}%` : formatNumber(value)
}

function formatPerMillion(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  if (value === 0) return "free"
  if (value < 0.01) return `$${value.toFixed(4)}`
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function formatPriceShort(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return "—"
  if (value === 0) return "free"
  if (value >= 1_000) {
    return `$${formatNumber(value / 1_000)}k`
  }
  if (value < 0.001) return "<$0.001"
  if (value < 1) return `$${value.toFixed(3)}`
  return `$${value.toFixed(2)}`
}

function formatContextShort(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "—"
  }
  if (value >= 1_000_000_000) {
    return `${formatNumber(value / 1_000_000_000)}B`
  }
  if (value >= 1_000_000) {
    const millions = value / 1_000_000
    return `${millions >= 10 ? Math.round(millions) : formatNumber(millions)}M`
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}K`
  }
  return formatNumber(value)
}

function formatContext(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return "—"
  }
  if (value >= 1_000_000) {
    return `${formatNumber(value / 1_000_000)}M`
  }
  if (value >= 1_000) {
    return `${formatNumber(value / 1_000)}K`
  }
  return formatNumber(value)
}

function formatTokensCompact(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0"
  if (value >= 1_000_000_000_000) {
    return `${formatNumber(value / 1_000_000_000_000)}t`
  }
  if (value >= 1_000_000_000) {
    return `${Math.round(value / 1_000_000_000)}b`
  }
  if (value >= 1_000_000) {
    return `${formatNumber(value / 1_000_000)}m`
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`
  }
  return formatNumber(value)
}

function formatPercentValue(value: number): string {
  return `${formatNumber(value)}%`
}

function formatRank(value: number): string {
  return `#${formatNumber(value)}`
}

function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "—"
  if (Number.isInteger(value)) {
    return value.toLocaleString("en-US")
  }
  return value.toFixed(1).replace(/\.0$/, "")
}

function priceCell(value: number | undefined): Cell {
  if (value === undefined) return textCell("—", "muted")
  return {
    text: formatPerMillion(value),
    value,
  }
}

function numericCell(
  value: number,
  format: (value: number) => string,
): Cell {
  return { text: format(value), value }
}

function booleanCell(value: boolean | undefined): Cell {
  if (value === undefined) return textCell("?", "muted")
  return value
    ? { text: "yes", tone: "yes" }
    : { text: "no", tone: "no" }
}

function textCell(value: string, tone?: CellTone): Cell {
  return { text: value, tone }
}

function parseEnrichment(value: unknown): Partial<Enrichment> {
  if (!isObject(value)) return {}

  const model = isObject(value.model) ? value.model : {}
  const usageValue = isObject(value.usage) ? value.usage : {}
  const priceValue = isObject(model.priceUsdPer1M)
    ? model.priceUsdPer1M
    : null

  const result: Partial<Enrichment> = {}

  if (priceValue) {
    const price: Cost = {
      input: numberField(priceValue.input),
      output: numberField(priceValue.output),
      cacheRead: numberField(priceValue.cachedInput),
      cacheWrite: numberField(priceValue.cacheWrite),
    }
    if (price.input !== undefined || price.output !== undefined) {
      result.price = price
    }
  }

  const usage: OpenCodeUsage = {
    tokens: numberField(usageValue.tokens),
    sharePercent: numberField(usageValue.sharePercent),
    rankLastWeek: numberField(usageValue.rankLastWeek),
    uniqueUsers: numberField(usageValue.uniqueUsers),
    weeklyRetentionPercent: numberField(
      usageValue.weeklyRetentionPercent,
    ),
    costPerSessionUsd: numberField(usageValue.costPerSessionUsd),
  }
  if (Object.values(usage).some((item) => item !== undefined)) {
    result.usage = usage
  }

  const benchmarks = parseBenchmarkList(model.benchmarks)
  if (benchmarks.length > 0) result.benchmarks = benchmarks

  return result
}

function openCodeDataUrl(id: string): string {
  const [lab = "", ...rest] = id.split("/")
  const model = rest.join("/")
  return `https://opencode.ai/data/${encodeURIComponent(
    slugify(lab),
  )}/${encodeURIComponent(slugify(model))}.json`
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/\./g, "-")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
}

function footerStatus(
  state: CompareState,
  compact: boolean,
): {
  text: string
  color: string
} {
  const now = Date.now()
  if (state.notice && state.notice.until > now) {
    return { text: state.notice.text, color: theme.amber }
  }
  if (state.loading) {
    return {
      text: compact
        ? "loading…"
        : state.catalog
          ? "refreshing…"
          : "loading catalog…",
      color: theme.dim,
    }
  }
  if (state.error) {
    return {
      text: state.catalog
        ? compact
          ? "stale"
          : `stale · ${formatAgo(now - (state.lastUpdated ?? now))}`
        : "offline",
      color: theme.amber,
    }
  }

  const active = [...state.enrichment.values()].filter(
    (item) => item.status === "loading",
  ).length
  if (active > 0) {
    return { text: `enriching ${active}…`, color: theme.dim }
  }
  if (state.catalog && state.catalog.pricingFetchedAt === null) {
    return {
      text: compact ? "no prices" : "pricing unavailable",
      color: theme.amber,
    }
  }
  if (state.catalog?.stale) {
    return {
      text: compact
        ? "cached"
        : `cached · ${formatAgo(now - state.catalog.fetchedAt)}`,
      color: theme.amber,
    }
  }

  const ago = formatAgo(now - (state.lastUpdated ?? now))
  return {
    text: compact ? ago : `updated ${ago}`,
    color: theme.dim,
  }
}

function listViewportRows(height: number): number {
  return Math.max(1, height - 9)
}

function tableDataRows(height: number): number {
  return Math.max(1, height - 9)
}

function pageSize(height: number): number {
  return Math.max(1, height - 10)
}

function maxTableOffset(
  state: CompareState,
  visibleRows: number,
): number {
  return Math.max(0, buildTableRows(state).length - visibleRows)
}

function tableLayout(
  inner: number,
  count: number,
): { labelWidth: number; columnWidth: number; gap: number } {
  const columns = Math.max(1, count)
  let labelWidth = clamp(Math.floor(inner * 0.28), 12, 26)
  let gap = columns > 2 && inner < 64 ? 1 : 2
  let columnWidth = Math.floor(
    (inner - labelWidth - gap * (columns - 1)) / columns,
  )

  if (columnWidth < 5) {
    labelWidth = clamp(Math.floor(inner * 0.18), 8, 16)
    gap = 1
    columnWidth = Math.floor(
      (inner - labelWidth - gap * (columns - 1)) / columns,
    )
  }

  return {
    labelWidth,
    columnWidth: Math.max(4, columnWidth),
    gap,
  }
}

function paint(
  color: string,
  text: string,
  highlight: boolean,
  strong = false,
): TextChunk {
  const base = strong ? bold(text) : text
  const styled = fg(color)(base)
  return highlight ? bg(theme.selection)(styled) : styled
}

function isPrintable(key: CompareKey): boolean {
  if (key.ctrl || key.meta) return false
  if (typeof key.sequence !== "string") return false
  const characters = [...key.sequence]
  return (
    characters.length === 1 &&
    key.sequence >= " " &&
    key.sequence !== "\u007f"
  )
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined
}

function toCatalogError(error: unknown): CatalogError {
  if (error instanceof CatalogError) return error
  const message = error instanceof Error ? error.message : String(error)
  return new CatalogError(
    "Something went wrong",
    message.trim() || "An unexpected error occurred.",
    "Press r to retry.",
  )
}

function compose(
  ...parts: Array<string | TextChunk | StyledText>
): StyledText {
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

function printCheck(catalog: Catalog): void {
  const chat = catalog.models.filter((model) => model.type === "chat")
  const priced = chat.filter(
    (model) => model.cost?.input !== undefined,
  ).length
  const benchmarked = chat.filter(
    (model) => model.benchmarks.length > 0,
  ).length

  console.log(`models           ${catalog.models.length}`)
  console.log(`chat models      ${chat.length}`)
  console.log(`with pricing     ${priced}`)
  console.log(`with benchmarks  ${benchmarked}`)
  console.log(
    `catalog          ${new Date(catalog.fetchedAt).toISOString()}${
      catalog.stale ? " (stale)" : ""
    }`,
  )
  console.log(
    `pricing          ${
      catalog.pricingFetchedAt
        ? new Date(catalog.pricingFetchedAt).toISOString()
        : "unavailable"
    }`,
  )
  console.log("")

  for (const model of sortModels(chat, "newest").slice(0, 5)) {
    console.log(
      `- ${model.id} · ${model.name} · ${formatPerMillion(
        model.cost?.input,
      )} in · ${formatContext(model.context)} ctx`,
    )
  }
}

function printHelp(): void {
  console.log(`oc-compare ${VERSION}

Compare LLM models in the terminal, using models.dev and OpenCode Data.

Usage:
  oc-compare [options]

Options:
  -h, --help       Show this help
  -v, --version    Show version
      --check      Load the catalog, print a summary, and exit
      --offline    Use the on-disk catalog cache without network access
      --no-cache   Fetch fresh data even when the cache is still valid

Keys:
  up/down, j/k  Move the model cursor, or scroll the comparison table
  space/enter   Add or remove the highlighted model (up to 4)
  /             Search by model, family, lab, or provider
  s             Cycle sort: newest, name, price, context
  tab           Move focus between the model list and the table
  x             Clear the comparison
  r             Refresh the catalog
  home/end      Jump to the start or end
  q             Quit

Cache:
  ${cacheLocation()}

Environment:
  OC_COMPARE_CACHE_DIR   Override the cache directory
  OC_COMPARE_TTL_HOURS   Cache lifetime in hours (default: 12)

Data:
  models.dev/models.json   model metadata and benchmarks
  models.dev/api.json      provider pricing
  opencode.ai/data/...     OpenCode usage and benchmark enrichment`)
}

function cacheLocation(): string {
  return cacheDirectory()
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return args.some((arg) => flags.includes(arg))
}

if (import.meta.main) {
  void main().catch((error: unknown) => {
    console.error("oc-compare failed:", error)
    process.exit(1)
  })
}
