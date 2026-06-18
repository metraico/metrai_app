import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * Convert a YYYY-MM-DD date string to ISO 8601 week string "YYYY-Www".
 * Correctly handles year boundaries (e.g. Dec 31, 2025 → "2026-W01").
 * Uses Thursday-anchored ISO week definition, matching Python's date.isocalendar().
 */
export function toIsoWeek(dateStr: string): string {
  const d = new Date(dateStr + 'T12:00:00') // noon avoids DST edge cases
  // Find Thursday of the current ISO week
  const thursday = new Date(d)
  thursday.setDate(d.getDate() + (4 - (d.getDay() || 7)))
  const isoYear = thursday.getFullYear()
  // Find first Thursday of the ISO year
  const jan4 = new Date(isoYear, 0, 4)
  const firstThursday = new Date(jan4)
  firstThursday.setDate(jan4.getDate() + (4 - (jan4.getDay() || 7)))
  const weekNum = Math.round((thursday.getTime() - firstThursday.getTime()) / (7 * 24 * 3600 * 1000)) + 1
  return `${isoYear}-W${String(weekNum).padStart(2, '0')}`
}
