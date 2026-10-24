export { cn } from "cn"

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago"; older: null (show the date instead). */
export function timeAgo(iso: string | null | undefined, now = Date.now()): string | null {
  if (!iso) return null;
  const s = Math.max(0, (now - new Date(iso).getTime()) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  if (d === 1) return "yesterday";
  if (d < 7) return `${d} days ago`;
  return null;
}

/** Minutes since `iso` ("0", "12"), for kitchen and table timers. */
export const minutesSince = (iso: string | null | undefined, now = Date.now()) =>
  iso ? Math.max(0, Math.floor((now - new Date(iso).getTime()) / 60000)) : 0;

/** A short random id (good enough for records kept in this browser). */
export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/** The text with its first letter in capitals ("delivery" → "Delivery"). */
export const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
