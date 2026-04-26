// Google reCAPTCHA v3 client. Loads the script lazily on first use so the
// dashboard's bundle and bundle-startup are not affected by Google's load
// time on visitors who never reach the Review page.
//
// Site key is read at build time from VITE_RECAPTCHA_SITE_KEY. When the var
// is unset (dev environments), `getRecaptchaToken()` resolves to undefined
// and the API is called without a token — the server's reCAPTCHA toggle is
// expected to be off in that environment.

declare global {
  interface Window {
    grecaptcha?: {
      ready: (cb: () => void) => void;
      execute: (siteKey: string, opts: { action: string }) => Promise<string>;
    };
  }
}

const SCRIPT_ID = 'recaptcha-v3-script';
let loadPromise: Promise<void> | null = null;

function siteKey(): string | undefined {
  return import.meta.env.VITE_RECAPTCHA_SITE_KEY || undefined;
}

function loadScript(key: string): Promise<void> {
  if (loadPromise) return loadPromise;
  loadPromise = new Promise<void>((resolve, reject) => {
    if (window.grecaptcha) return resolve();
    const existing = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true });
      existing.addEventListener('error', () => reject(new Error('reCAPTCHA failed to load')), { once: true });
      return;
    }
    const s = document.createElement('script');
    s.id = SCRIPT_ID;
    s.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(key)}`;
    s.async = true;
    s.defer = true;
    s.addEventListener('load', () => resolve(), { once: true });
    s.addEventListener('error', () => reject(new Error('reCAPTCHA failed to load')), { once: true });
    document.head.appendChild(s);
  });
  return loadPromise;
}

/** Returns a v3 token for the given action, or undefined if reCAPTCHA isn't
 *  configured for this build. Errors propagate; callers decide whether to
 *  block the user (production) or fall back to a tokenless call (dev). */
export async function getRecaptchaToken(action: string): Promise<string | undefined> {
  const key = siteKey();
  if (!key) return undefined;
  await loadScript(key);
  return new Promise<string>((resolve, reject) => {
    if (!window.grecaptcha) return reject(new Error('reCAPTCHA unavailable'));
    window.grecaptcha.ready(() => {
      window.grecaptcha!
        .execute(key, { action })
        .then(resolve)
        .catch(reject);
    });
  });
}
