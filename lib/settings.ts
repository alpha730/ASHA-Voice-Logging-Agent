/**
 * Per-device settings kept in localStorage. Storage can be missing or throw (private windows,
 * blocked site data), so every read and write is guarded and a default is always returned.
 */

type Store = Pick<Storage, "getItem" | "setItem"> | null | undefined;

export const SETTING_KEYS = { lang: "asha.lang", micMode: "asha.micMode" } as const;

export function readSetting<T extends string>(store: Store, key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = store?.getItem(key);
    return v != null && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export function writeSetting(store: Store, key: string, value: string): void {
  try {
    store?.setItem(key, value);
  } catch {}
}

/** The browser's localStorage, or null where touching it throws. */
export function browserStore(): Store {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}
