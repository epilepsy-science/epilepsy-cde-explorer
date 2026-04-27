// Shared fetch for the runtime dashboard config (review scope + enabled
// sources). Operators flip the values via SSM; the dashboard reads them
// once at boot via GET /v1/dashboard-config and uses them to:
//   - hide CDEs/Bundles from disabled sources
//   - restrict the review session candidate pool when scope is allowlist-only
//
// The fetch is cached as a promise so concurrent callers (useDuckDB,
// useReviewStore) share a single network roundtrip. On error or timeout we
// resolve to permissive defaults — the dashboard should still work even
// if the API is briefly unavailable.

import { api, unwrap } from './client';

export interface ReviewScope {
  all_open: boolean;
  cdes: string[];
  bundles: string[];
}

export interface DashboardConfig {
  review_scope: ReviewScope;
  enabled_sources: string[];
}

const FETCH_TIMEOUT_MS = 4000;
const PERMISSIVE: DashboardConfig = {
  review_scope: { all_open: true, cdes: [], bundles: [] },
  enabled_sources: [],
};

let cached: Promise<DashboardConfig> | null = null;

export function fetchDashboardConfig(): Promise<DashboardConfig> {
  if (cached) return cached;
  cached = (async () => {
    try {
      const result = await Promise.race<DashboardConfig | null>([
        unwrap(api.GET('/v1/dashboard-config')),
        new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), FETCH_TIMEOUT_MS),
        ),
      ]);
      if (!result) return PERMISSIVE;
      return result;
    } catch {
      return PERMISSIVE;
    }
  })();
  return cached;
}

/** Force the next call to refetch. Used in dev/test; not currently wired
 *  to any UI. */
export function resetDashboardConfigCache() {
  cached = null;
}
