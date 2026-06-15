interface FilterSelectProps {
  label: string
  value: string
  options: { value: string; label: string }[]
  onChange: (v: string) => void
  variant?: 'light' | 'dark'
}

export function FilterSelect({ label, value, options, onChange, variant = 'light' }: FilterSelectProps) {
  const isDark = variant === 'dark'
  return (
    <div className={isDark ? 'space-y-1' : 'flex items-center gap-2'}>
      <span className={isDark
        ? 'block text-[9px] font-bold uppercase tracking-widest text-charcoal-blue-400'
        : 'text-xs font-semibold text-charcoal-blue-500'
      }>
        {label}
      </span>
      <div className="relative">
        <select
          value={value}
          onChange={e => onChange(e.target.value)}
          className={isDark
            ? 'w-full appearance-none rounded-lg border border-white/10 bg-charcoal-blue-800 px-2 py-1.5 pr-6 text-[11px] text-charcoal-blue-100 focus:border-majorelle-blue-500 focus:outline-none'
            : 'w-48 truncate appearance-none rounded-xl border border-charcoal-blue-200 bg-white px-3 py-1.5 pr-7 text-xs font-medium text-charcoal-blue-950 focus:border-majorelle-blue-500 focus:outline-none'
          }
        >
          <option value="">All</option>
          {options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <span className={`pointer-events-none absolute top-1/2 -translate-y-1/2 ${isDark ? 'right-1.5 text-[8px] text-charcoal-blue-400' : 'right-2 text-charcoal-blue-400'}`}>▼</span>
      </div>
    </div>
  )
}
