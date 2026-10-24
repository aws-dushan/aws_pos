/**
 * The web address prefix of this installation. On the servers live is served at /awsone and test at /awsone-test on the shared
 * address (deploy/README.md); locally it is empty. Next adds it to <Link>, router.push and its own assets; anything that builds a
 * URL by hand (fetch, window.location, next/image src, links put in e-mails) goes through withBase.
 */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

/** An app path ("/sales/docs/…") as the browser must request it. */
export function withBase(path: string): string {
  return BASE_PATH + path;
}

/** A browser path back to the app path (a DOM href or location.pathname include the prefix; usePathname does not). */
export function stripBase(path: string): string {
  if (!BASE_PATH) return path;
  if (path === BASE_PATH) return "/";
  return path.startsWith(BASE_PATH + "/") || path.startsWith(BASE_PATH + "?") ? path.slice(BASE_PATH.length) : path;
}

/**
 * localStorage for this installation only. Live, test and the other applications on the shared address are one browser origin and
 * would otherwise read each other's entries (a company chosen in test opening in live), so keys carry the prefix.
 */
export const appStorage = {
  getItem: (key: string) => localStorage.getItem(BASE_PATH + key),
  setItem: (key: string, value: string) => localStorage.setItem(BASE_PATH + key, value),
  removeItem: (key: string) => localStorage.removeItem(BASE_PATH + key),
};
