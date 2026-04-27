// Google Analytics 4 wrapper. Loaded only when VITE_GA_MEASUREMENT_ID is set
// at build time, so dev/preview/CI builds never hit production analytics.
//
// Why a hand-rolled wrapper instead of vue-gtag-next:
//   - This site uses hash-based routing, so a vanilla gtag config that
//     auto-tracks page_view on load misses subsequent SPA navigations.
//     A 30-line wrapper is clearer than wrestling with library opinions.
//   - We never want to leak email / review content as event labels, so
//     keeping the trackEvent surface small + reviewable is the priority.
//
// Privacy posture:
//   - anonymize_ip: true (truncates the last octet before logging)
//   - cookie_flags 'SameSite=None;Secure' for cross-origin auth flow safety
//   - No call site passes user identifiers; events are anonymized by
//     construction.

declare global {
  interface Window {
    dataLayer?: unknown[];
    gtag?: (...args: unknown[]) => void;
  }
}

const MEASUREMENT_ID = import.meta.env.VITE_GA_MEASUREMENT_ID || '';

let installed = false;

/** Load gtag.js + initialize. Idempotent; safe to call once at app boot. */
export function installAnalytics(): void {
  if (installed) return;
  if (!MEASUREMENT_ID) return;
  if (typeof window === 'undefined') return;

  installed = true;

  window.dataLayer = window.dataLayer || [];
  // gtag is a tiny shim that pushes args onto dataLayer until gtag.js loads.
  window.gtag = function gtagShim(...args: unknown[]) {
    window.dataLayer!.push(args);
  };

  window.gtag('js', new Date());
  window.gtag('config', MEASUREMENT_ID, {
    anonymize_ip: true,
    cookie_flags: 'SameSite=None;Secure',
    // We send page_view manually after each router navigation so SPA route
    // changes register as distinct page views. Disable the default initial
    // auto-send to avoid double-counting.
    send_page_view: false,
  });

  const script = document.createElement('script');
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(MEASUREMENT_ID)}`;
  document.head.appendChild(script);
}

/** Send a page_view event. Call after each SPA navigation. Includes the
 *  full route path so hash-routed apps don't all collapse to '/'. */
export function trackPageView(path: string, title?: string): void {
  if (!MEASUREMENT_ID || typeof window === 'undefined' || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_title: title ?? document.title,
    page_path: path,
    page_location: window.location.href,
  });
}

/** Send a custom event. Keep params PII-free — no emails, names, or review
 *  content. Common events: cde_drawer_opened, crf_created, review_submitted,
 *  concept_clicked, redcap_exported. */
export function trackEvent(name: string, params: Record<string, string | number | boolean> = {}): void {
  if (!MEASUREMENT_ID || typeof window === 'undefined' || !window.gtag) return;
  window.gtag('event', name, params);
}
