import type { ReactNode } from "react";
import { SensorStatus, type SensorStatusCode } from "@/lib/sensors";

/**
 * Small shared primitives. Deliberately a handful of plain components rather
 * than a UI dependency — the dashboard needs six of these, not a library.
 */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={`flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-1 shadow-panel ${className}`}
    >
      {(title !== undefined || actions !== undefined) && (
        <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 py-3.5">
          <div className="min-w-0">
            {title !== undefined && (
              <h2 className="truncate text-[13px] font-semibold tracking-tight text-text-primary">
                {title}
              </h2>
            )}
            {subtitle !== undefined && (
              <p className="mt-1 truncate text-[11px] leading-none text-text-muted">{subtitle}</p>
            )}
          </div>
          {actions !== undefined && <div className="shrink-0">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

/**
 * Status roles always pair the colour with an icon glyph and a text label, so
 * state never depends on colour alone.
 */
const STATUS_PRESENTATION: Record<
  SensorStatusCode,
  { label: string; glyph: string; text: string; chip: string }
> = {
  [SensorStatus.Normal]: {
    label: "Normal",
    glyph: "●",
    text: "text-good",
    chip: "border-good/30 bg-good/10 text-good",
  },
  [SensorStatus.Warning]: {
    label: "Warning",
    glyph: "▲",
    text: "text-warning",
    chip: "border-warning/40 bg-warning/15 text-warning",
  },
  [SensorStatus.Alarm]: {
    label: "Alarm",
    glyph: "■",
    text: "text-critical",
    chip: "border-critical/40 bg-critical/15 text-critical",
  },
  [SensorStatus.Stale]: {
    label: "Stale",
    glyph: "–",
    text: "text-stale",
    chip: "border-border-strong bg-surface-2 text-text-muted",
  },
};

export function statusPresentation(status: SensorStatusCode) {
  return STATUS_PRESENTATION[status] ?? STATUS_PRESENTATION[SensorStatus.Stale];
}

export function StatusChip({ status }: { status: SensorStatusCode }) {
  const presentation = statusPresentation(status);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-medium ${presentation.chip}`}
    >
      <span aria-hidden="true" className="text-[8px] leading-none">
        {presentation.glyph}
      </span>
      {presentation.label}
    </span>
  );
}

/**
 * A single headline number. The value is the loudest thing in the tile; the
 * label and hint stay in text tokens. A tile carrying a non-neutral tone also
 * shows a coloured rail, so the tone is not the only signal.
 */
export function StatTile({
  label,
  value,
  unit,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  unit?: string;
  hint?: string;
  tone?: "neutral" | "accent" | "good" | "warning" | "critical";
}) {
  const toneClass = {
    neutral: "text-text-primary",
    accent: "text-accent",
    good: "text-good",
    warning: "text-warning",
    critical: "text-critical",
  }[tone];

  const railClass = {
    neutral: "bg-border-strong",
    accent: "bg-accent",
    good: "bg-good",
    warning: "bg-warning",
    critical: "bg-critical",
  }[tone];

  return (
    <div className="relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-border-subtle bg-surface-1 px-4 py-3.5 shadow-panel">
      <span aria-hidden="true" className={`absolute inset-y-0 left-0 w-0.5 ${railClass}`} />
      <span className="truncate text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="mt-1.5 flex items-baseline gap-1">
        <span className={`tabular text-[26px] font-semibold leading-none ${toneClass}`}>
          {value}
        </span>
        {unit !== undefined && (
          <span className="text-[11px] font-medium text-text-muted">{unit}</span>
        )}
      </span>
      {hint !== undefined && (
        <span className="mt-1.5 truncate text-[11px] leading-none text-text-muted">{hint}</span>
      )}
    </div>
  );
}

export function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string; title?: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="flex gap-0.5 rounded-lg bg-surface-2 p-0.5"
      >
        {options.map((option) => {
          const selected = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              title={option.title}
              aria-pressed={selected}
              onClick={() => onChange(option.value)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
                selected
                  ? "bg-accent text-accent-contrast shadow-panel"
                  : "text-text-muted hover:bg-surface-1 hover:text-text-secondary"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function Button({
  children,
  onClick,
  disabled = false,
  variant = "default",
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  variant?: "default" | "accent";
  title?: string;
}) {
  const variantClass =
    variant === "accent"
      ? "border-transparent bg-accent text-accent-contrast enabled:hover:bg-accent-hover"
      : "border-border-strong bg-surface-1 text-text-secondary enabled:hover:border-accent enabled:hover:text-accent";

  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-2.5 py-1.5 text-[11px] font-medium transition-colors disabled:opacity-40 ${variantClass}`}
    >
      {children}
    </button>
  );
}

const FIELD_CLASS =
  "min-w-0 rounded-lg border border-border-strong bg-surface-1 px-2.5 py-1.5 text-xs text-text-primary transition-colors placeholder:text-text-muted hover:border-accent/50 focus:border-accent focus:outline-none";

export function TextField({
  label,
  value,
  placeholder,
  onChange,
  className = "",
}: {
  label: string;
  value: string;
  placeholder?: string;
  onChange: (value: string) => void;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <input type="text" value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} className={FIELD_CLASS} />
    </label>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  className = "",
}: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <span className="text-[11px] font-medium uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <select value={value} onChange={(event) => onChange(event.target.value as T)} className={FIELD_CLASS}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

/** A labelled row of filter controls, shared by both tables. */
export function FilterBar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-end gap-3 border-y border-border-subtle bg-surface-2/50 px-5 py-3">
      {children}
    </div>
  );
}
