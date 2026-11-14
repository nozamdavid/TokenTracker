import { isLocalDashboardOrigin } from "./local-origin";

/**
 * Distinguishes local CLI / NPX / embedded-app usage from a public deployment hostname.
 * Used for default route (dashboard vs landing) and Home link targets.
 */
/** True when loopback or an explicitly configured remote origin serves the local dashboard. */
export function isLocalDashboardHost(): boolean {
  if (typeof window === "undefined") return false;
  const h = window.location.hostname;
  return isLocalDashboardOrigin() || h === "::1" || h === "[::1]";
}

/** Path to open the dashboard from marketing: loopback keeps `/` as dashboard; public deploy uses `/dashboard` while `/` stays landing. */
export function getDashboardEntryPath(): string {
  return isLocalDashboardHost() ? "/" : "/dashboard";
}
