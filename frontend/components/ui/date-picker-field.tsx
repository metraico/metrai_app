"use client"

import * as React from "react"
import { DayPicker } from "react-day-picker"
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn, formatDateDisplay, parseDisplayToISO } from "@/lib/utils"

// Deliberately no default react-day-picker stylesheet — themed with Tailwind classes
// below to match this app's compact scale (10-11px labels, tight spacing) instead of
// the library's larger generic defaults.
const dayPickerClassNames = {
  months: "flex",
  month: "space-y-1.5",
  month_caption: "relative flex h-6 items-center justify-center pointer-events-none",
  caption_label: "text-xs font-bold text-charcoal-blue-900",
  nav: "absolute inset-x-0 top-0 z-10 flex h-6 items-center justify-between",
  button_previous: "flex h-6 w-6 items-center justify-center rounded text-charcoal-blue-400 hover:bg-charcoal-blue-50 hover:text-majorelle-blue-500 disabled:opacity-30 disabled:hover:bg-transparent",
  button_next: "flex h-6 w-6 items-center justify-center rounded text-charcoal-blue-400 hover:bg-charcoal-blue-50 hover:text-majorelle-blue-500 disabled:opacity-30 disabled:hover:bg-transparent",
  month_grid: "mt-1 w-full border-collapse",
  weekday: "h-6 w-7 text-center text-[9px] font-bold uppercase tracking-wide text-charcoal-blue-400",
  day: "p-0 text-center",
  day_button: "flex h-7 w-7 items-center justify-center rounded-md text-xs font-medium text-charcoal-blue-700 transition-colors hover:bg-majorelle-blue-50",
  selected: "[&>button]:bg-majorelle-blue-500 [&>button]:font-semibold [&>button]:text-white [&>button]:hover:bg-majorelle-blue-600",
  today: "[&>button]:ring-1 [&>button]:ring-inset [&>button]:ring-majorelle-blue-300",
  outside: "[&>button]:text-charcoal-blue-300",
  disabled: "[&>button]:cursor-not-allowed [&>button]:opacity-30 [&>button]:hover:bg-transparent",
}

const dayPickerComponents = {
  Chevron: ({ orientation }: { orientation?: "up" | "down" | "left" | "right" }) =>
    orientation === "right" ? <ChevronRight size={14} /> : <ChevronLeft size={14} />,
}

interface DatePickerFieldProps {
  /** Plain "YYYY-MM-DD" — the app's internal date representation. */
  value: string
  /** Called with a new "YYYY-MM-DD" value once the user picks a date or types a complete one. */
  onChange: (iso: string) => void
  /** Plain "YYYY-MM-DD" — dates before this are disabled in the calendar (mirrors native <input min>). */
  minDateISO?: string
  inputClassName?: string
  className?: string
}

/** Text input showing MM/DD/YYYY, paired with a calendar-icon button that opens a react-day-picker
 *  popover. Internal value/onChange stay plain ISO strings — this is purely a display/interaction layer. */
export function DatePickerField({ value, onChange, minDateISO, inputClassName, className }: DatePickerFieldProps) {
  const [open, setOpen] = React.useState(false)
  const [text, setText] = React.useState(formatDateDisplay(value))

  // Keep the text in sync when `value` changes from outside (e.g. loading a saved run).
  React.useEffect(() => {
    setText(formatDateDisplay(value))
  }, [value])

  const selected = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(value + "T12:00:00") : undefined
  const minDate = minDateISO && /^\d{4}-\d{2}-\d{2}$/.test(minDateISO) ? new Date(minDateISO + "T12:00:00") : undefined

  const commitText = () => {
    const iso = parseDisplayToISO(text)
    if (/^\d{4}-\d{2}-\d{2}$/.test(iso)) {
      onChange(iso)
    } else {
      setText(formatDateDisplay(value)) // invalid/incomplete — revert to last good value
    }
  }

  return (
    <div className={cn("relative flex items-center", className)}>
      <input
        type="text"
        value={text}
        onChange={e => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={e => { if (e.key === "Enter") e.currentTarget.blur() }}
        placeholder="MM/DD/YYYY"
        pattern="\d{2}/\d{2}/\d{4}"
        className={cn(inputClassName, "pr-7")}
      />
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label="Open calendar"
            className="absolute right-1.5 flex h-5 w-5 items-center justify-center rounded text-charcoal-blue-400 hover:text-majorelle-blue-500"
          >
            <CalendarDays size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2.5" align="start">
          <DayPicker
            mode="single"
            selected={selected}
            defaultMonth={selected}
            disabled={minDate ? { before: minDate } : undefined}
            classNames={dayPickerClassNames}
            components={dayPickerComponents}
            onSelect={d => {
              if (!d) return
              const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
              onChange(iso)
              setText(formatDateDisplay(iso))
              setOpen(false)
            }}
          />
        </PopoverContent>
      </Popover>
    </div>
  )
}
