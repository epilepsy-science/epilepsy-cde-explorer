// Typed API client. Wraps `openapi-fetch` with:
//   - the API base URL (from VITE_API_BASE_URL or a sensible default)
//   - JWT injection from localStorage on every protected request
//   - convenience reactive token storage so components can react to
//     login/logout via the `token` ref
//
// All call sites get inferred request/response types straight from the
// OpenAPI spec at api/openapi.yaml — regenerate with `yarn sync-api-types`.

import { ref } from 'vue';
import createClient from 'openapi-fetch';
import type { paths } from './generated/schema';

const TOKEN_KEY = 'cde-review.api-token';

const baseUrl = (
  import.meta.env.VITE_API_BASE_URL ||
  // Fall back to api.<dashboard-host> in prod-like setups; use localhost in dev.
  (typeof window !== 'undefined' && window.location.hostname === 'cde.epilepsy.science'
    ? 'https://api.cde.epilepsy.science'
    : 'http://localhost:8080')
);

export const apiToken = ref<string | null>(readToken());

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(t: string | null): void {
  apiToken.value = t;
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {}
}

const rawClient = createClient<paths>({ baseUrl });

// Add Bearer header on every request when a token is present. Using the
// middleware hook keeps the public/protected route distinction implicit —
// public routes simply ignore the header server-side.
rawClient.use({
  onRequest({ request }) {
    if (apiToken.value) {
      request.headers.set('authorization', `Bearer ${apiToken.value}`);
    }
    return request;
  },
  onResponse({ response }) {
    // A 401 from a protected endpoint with a stored token = token expired or
    // revoked. Drop it so the dashboard redirects to verification next time.
    if (response.status === 401 && apiToken.value) {
      setToken(null);
    }
    return response;
  },
});

/** The typed API client. Use as `api.GET('/v1/me')`, `api.POST('/v1/reviews', { body })`, etc. */
export const api = rawClient;

/** Convenience: throws on non-2xx so call sites can `try/await` instead of inspecting `.error`. */
export async function unwrap<T>(p: Promise<{ data?: T; error?: unknown; response: Response }>): Promise<T> {
  const { data, error, response } = await p;
  if (error || !response.ok) {
    const err = error as { error?: { code?: string; message?: string } } | undefined;
    const msg = err?.error?.message ?? `HTTP ${response.status}`;
    throw new ApiError(response.status, err?.error?.code ?? 'http_error', msg);
  }
  return data as T;
}

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}
