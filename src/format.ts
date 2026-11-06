import { fg, t, type StyledText } from "@opentui/core"
import { theme } from "./theme"

const DAY_MS = 86_400_000

export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(100, Math.max(0, value))
}

export function remainingPercent(used: number): number {
  return clampPercent(100 - clampPercent(used))
}

export function formatPercent(value: number): string {
  return `${Math.round(clampPercent(value))}%`
}

export function meterColor(remaining: number, limited: boolean): string {
  if (limited || remaining <= 20) return theme.red
  if (remaining <= 50) return theme.amber
  return theme.green
}

export function renderBar(used: number, width: number, color: string): StyledText {
  const columns = Math.max(1, Math.floor(width))
  const filled = Math.round((clampPercent(used) / 100) * columns)
  const empty = Math.max(0, columns - filled)
  return t`${fg(color)("█".repeat(filled))}${fg(theme.barTrack)("░".repeat(empty))}`
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "now"

  const totalSeconds = Math.floor(ms / 1000)
  if (totalSeconds < 60) return "<1m"

  const totalMinutes = Math.floor(totalSeconds / 60)
  if (totalMinutes < 60) return `${totalMinutes}m`

  const totalHours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (totalHours < 24) {
    return minutes === 0 ? `${totalHours}h` : `${totalHours}h ${minutes}m`
  }

  const days = Math.floor(totalHours / 24)
  const hours = totalHours % 24
  return hours === 0 ? `${days}d` : `${days}d ${hours}h`
}

export function formatShort(ms: number): string {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  return formatDuration(ms)
}

export function formatAgo(ms: number): string {
  const elapsed = Math.max(0, ms)
  if (elapsed < 1000) return "just now"

  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 60) return `${seconds}s ago`

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`

  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes === 0 ? `${hours}h ago` : `${hours}h ${remainingMinutes}m ago`
  }

  return `${Math.floor(hours / 24)}d ago`
}

export function formatResetClock(resetsAt: number, now: number): string {
  const date = new Date(resetsAt)
  if (Number.isNaN(date.getTime())) return "unknown"

  const nowDate = new Date(now)
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })

  const dayDiff = Math.round((startOfLocalDay(date) - startOfLocalDay(nowDate)) / DAY_MS)
  if (dayDiff === 0) return `Today at ${time}`
  if (dayDiff === 1) return `Tomorrow at ${time}`
  if (dayDiff > 1 && dayDiff < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" })
    return `${weekday} at ${time}`
  }

  const dayMonth = date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
  })
  return `${dayMonth} at ${time}`
}

export function truncateText(value: string, maxLength: number): string {
  const characters = [...value]
  if (characters.length <= maxLength) return value
  if (maxLength <= 1) return "…"
  return `${characters.slice(0, maxLength - 1).join("")}…`
}

function startOfLocalDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}
