const NUMBER_FORMATTERS = new Map<number, Intl.NumberFormat>();

/** Cached `Intl.NumberFormat`; constructing one per cell is surprisingly slow. */
function formatter(digits: number): Intl.NumberFormat {
  let instance = NUMBER_FORMATTERS.get(digits);
  if (instance === undefined) {
    instance = new Intl.NumberFormat("en-US", {
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    });
    NUMBER_FORMATTERS.set(digits, instance);
  }
  return instance;
}

export function formatValue(value: number, digits = 2): string {
  if (!Number.isFinite(value)) return "—";
  return formatter(digits).format(value);
}

export function formatCount(value: number): string {
  return formatter(0).format(value);
}

export function formatBytes(bytesPerSecond: number): string {
  if (bytesPerSecond < 1024) return `${Math.round(bytesPerSecond)} B`;
  if (bytesPerSecond < 1024 * 1024) return `${(bytesPerSecond / 1024).toFixed(1)} KB`;
  return `${(bytesPerSecond / (1024 * 1024)).toFixed(2)} MB`;
}

export function formatClock(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp === 0) return "—";
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

export function formatClockMs(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp === 0) return "—";
  const date = new Date(timestamp);
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${String(
    date.getMilliseconds(),
  ).padStart(3, "0")}`;
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}
