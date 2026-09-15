/**
 * localStorage that cannot take the app down with it.
 *
 * Every browser this runs on has the API; not every browser lets you use it.
 * A private window, a webview with storage switched off by policy, a full
 * disk — each of these throws rather than politely doing nothing, and the
 * throw comes from whatever line happened to ask. Those lines are in the
 * providers at the root, so a phone that refuses storage didn't lose a
 * preference, it lost the whole screen: "Something went wrong · blocked".
 *
 * So nothing reads or writes localStorage directly. This is the only module
 * that names it, every call is guarded, and a refusal reads as "nothing
 * stored" — which is exactly what it is.
 *
 * What must genuinely survive on a device the app has never met lives in
 * cookies instead (see `cookies.ts`). This is for the rest: preferences worth
 * keeping and not worth failing over.
 */

export const local = {
  get(key: string): string | null {
    try {
      return typeof localStorage === "undefined"
        ? null
        : localStorage.getItem(key);
    } catch {
      return null;
    }
  },

  /** Returns whether it stuck, for the one caller that has to care. */
  set(key: string, value: string): boolean {
    try {
      if (typeof localStorage === "undefined") return false;
      localStorage.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  },

  remove(key: string): void {
    try {
      if (typeof localStorage !== "undefined") localStorage.removeItem(key);
    } catch {
      // Nothing to do about it, and nothing that depends on it.
    }
  },
};
