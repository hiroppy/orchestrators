export function capitalize(value: string): string {
  return value.length > 0 ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

export function normalizeStatus(status: string): string {
  return status.trim().toLowerCase();
}

export function positiveNumber(value: unknown): boolean {
  const number = Number(value);
  return Number.isFinite(number) && number > 0;
}

export function formatNumber(value: unknown): string {
  return Math.trunc(Number(value)).toLocaleString("en-US");
}

export function formatCompactNumber(value: unknown): string {
  const number = Number(value);
  if (number < 1_000) return formatNumber(number);
  if (number < 1_000_000) return `${stripTrailingZero((number / 1_000).toFixed(1))}k`;
  return `${stripTrailingZero((number / 1_000_000).toFixed(1))}m`;
}

export function truncate(value: string, length: number): string {
  return value.length <= length ? value : `${value.slice(0, length - 1)}…`;
}

export function escapeExceptLinks(value: string): string {
  return /^<(?:https?:\/\/|@[^>]+>|![^>]+>)/.test(value) ? value : escapeSlack(value);
}

export function escapeSlack(value: unknown): string {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function escapeSlackLinkLabel(value: unknown): string {
  return escapeSlack(value).replaceAll("|", "｜");
}

export function isPresent<T>(value: T | null | undefined | false): value is T {
  return value !== null && value !== undefined && value !== false;
}

function stripTrailingZero(value: string): string {
  return value.endsWith(".0") ? value.slice(0, -2) : value;
}
