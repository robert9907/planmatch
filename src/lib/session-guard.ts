// Monkey-patches window.fetch so any 401 from a same-origin /api/* call
// redirects the browser to https://crm.generationhealth.me/unlock with
// the current URL encoded in ?next=. Wired from src/main.tsx so it
// activates before the React tree mounts.
//
// Third-party 401s pass through untouched.

const UNLOCK = 'https://crm.generationhealth.me/unlock';

let installed = false;

function isGuardedUrl(url: string): boolean {
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin !== window.location.origin) return false;
    if (!u.pathname.startsWith('/api/')) return false;
    return true;
  } catch {
    return false;
  }
}

function currentNext(): string {
  return (
    window.location.pathname +
    window.location.search +
    window.location.hash
  );
}

export function installSessionGuard(): void {
  if (installed) return;
  if (typeof window === 'undefined') return;
  installed = true;

  const originalFetch = window.fetch.bind(window);

  window.fetch = async function guardedFetch(input, init) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.href
        : (input as Request).url;
    const res = await originalFetch(input as RequestInfo, init);
    if (res.status === 401 && url && isGuardedUrl(url)) {
      const nextParam = encodeURIComponent(
        `https://agent.generationhealth.me${currentNext()}`,
      );
      window.location.href = `${UNLOCK}?next=${nextParam}`;
      return new Promise(() => {}) as Promise<Response>;
    }
    return res;
  };
}
