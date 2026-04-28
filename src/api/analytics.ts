// Google Analytics 4 wrapper. The gtag.js script tag and the gtag()
// initializer are emitted directly into index.html so they load before any
// JS parses — easier to verify in view-source and immune to bundle errors
// blocking install. This module just exposes typed helpers for the events
// our code emits, which call into the window.gtag set up by the inline
// snippet.
//
// When VITE_GA_MEASUREMENT_ID is unset at build time, the inline snippet
// early-returns and never defines window.gtag — so trackPageView /
// trackEvent become no-ops automatically. No dev/preview build accidentally
// pings production analytics.
//
// Privacy posture (set in index.html's gtag('config', ...)):
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

/** Send a page_view event. Call after each SPA navigation. Includes the
 *  full route path so hash-routed apps don't all collapse to '/'. */
export function trackPageView(path: string, title?: string): void {
  if (typeof window === 'undefined' || !window.gtag) return;
  window.gtag('event', 'page_view', {
    page_title: title ?? document.title,
    page_path: path,
    page_location: window.location.href,
  });
}

/** Send a custom event. Keep params PII-free — no emails, names, or review
 *  content. Common events: cde_drawer_opened, crf_created, review_submitted,
 *  concept_clicked, redcap_exported, json_schema_exported, pdf_exported. */
export function trackEvent(name: string, params: Record<string, string | number | boolean> = {}): void {
  if (typeof window === 'undefined' || !window.gtag) return;
  window.gtag('event', name, params);
}
