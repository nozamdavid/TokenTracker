type LocationLike = Pick<Location, "hostname" | "origin">;

export function isLocalDashboardOrigin(
  location: LocationLike | null = typeof window === "undefined" ? null : window.location,
  configuredOrigin: string | undefined = import.meta.env.VITE_TOKENTRACKER_LOCAL_ORIGIN,
) {
  if (!location) return false;
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return true;
  return Boolean(configuredOrigin && location.origin === configuredOrigin);
}
