export interface AppConfig {
  showCredit: boolean;
}

const DEFAULTS: AppConfig = { showCredit: true };

/** Reads /config.json next to the page. Anything missing, invalid or unreachable falls back to the defaults. */
export async function loadConfig(url = "/config.json"): Promise<AppConfig> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) return { ...DEFAULTS };
    const data: unknown = await res.json();
    if (data && typeof data === "object" && typeof (data as { showCredit?: unknown }).showCredit === "boolean") {
      return { showCredit: (data as { showCredit: boolean }).showCredit };
    }
  } catch {
    /* fall through to the defaults */
  }
  return { ...DEFAULTS };
}
