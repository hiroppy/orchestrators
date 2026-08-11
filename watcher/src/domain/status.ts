export function normalizeStatus(status: string): string;
export function normalizeStatus(status?: string | null): string | undefined;
export function normalizeStatus(status?: string | null): string | undefined {
  return status?.trim().toLowerCase();
}
