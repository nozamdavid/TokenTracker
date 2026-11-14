import { describe, expect, it } from "vitest";
import { isLocalDashboardOrigin } from "./local-origin";

describe("isLocalDashboardOrigin", () => {
  const configuredOrigin = "https://davids-macbook-pro.barbel-hops.ts.net:8443";

  it("keeps localhost and 127.0.0.1 local", () => {
    expect(isLocalDashboardOrigin({ hostname: "localhost", origin: "http://localhost:7680" }, configuredOrigin)).toBe(true);
    expect(isLocalDashboardOrigin({ hostname: "127.0.0.1", origin: "http://127.0.0.1:7680" }, configuredOrigin)).toBe(true);
  });

  it("accepts only the exact configured remote origin", () => {
    expect(isLocalDashboardOrigin({ hostname: "davids-macbook-pro.barbel-hops.ts.net", origin: configuredOrigin }, configuredOrigin)).toBe(true);
    for (const origin of [
      "https://davids-macbook-pro.barbel-hops.ts.net",
      "https://other.barbel-hops.ts.net:8443",
      "http://davids-macbook-pro.barbel-hops.ts.net:8443",
      "https://davids-macbook-pro.barbel-hops.ts.net.evil.example:8443",
    ]) {
      expect(isLocalDashboardOrigin({ hostname: new URL(origin).hostname, origin }, configuredOrigin)).toBe(false);
    }
    expect(isLocalDashboardOrigin({ hostname: "davids-macbook-pro.barbel-hops.ts.net", origin: configuredOrigin }, "")).toBe(false);
    expect(isLocalDashboardOrigin(null, configuredOrigin)).toBe(false);
  });
});
