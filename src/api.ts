/**
 * Taiga REST transport: one authenticated axios client, token cache, error preservation.
 *
 * Taiga paginates list endpoints at 30 items with `x-pagination-*` response headers and
 * honours the `x-disable-pagination` request header, so no page-walking loop is needed.
 */

import axios, { isAxiosError } from 'axios';
import type { AxiosInstance, AxiosResponse } from 'axios';
import type {
  ApiError,
  AuthResponse,
  JsonBody,
  QueryParams,
  TaigaErrorBody,
  TaigaProject,
  TaigaTaxonomyItem,
  TaigaUser,
} from './types.js';

export const DEFAULT_API_URL = 'https://api.taiga.io/api/v1';
const REQUEST_TIMEOUT_MS = 30_000;

let warnedInsecureHttp = false;

/**
 * API root, read at call time.
 *
 * MUST stay lazy: ES module imports are evaluated before any statement in the importing
 * module, so a module-level constant here would be fixed before src/index.js calls
 * dotenv.config() and TAIGA_API_URL from .env would be silently ignored — every request
 * would go to the public taiga.io instead of the configured host.
 */
export function apiBaseUrl(): string {
  const url = process.env.TAIGA_API_URL || DEFAULT_API_URL;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid TAIGA_API_URL: "${url}" is not a valid URL`);
  }
  if (parsed.protocol !== 'https:') {
    const isLoopback = parsed.hostname === 'localhost'
      || parsed.hostname === '127.0.0.1'
      || parsed.hostname === '::1'
      || parsed.hostname === '[::1]';
    if (!isLoopback && !warnedInsecureHttp) {
      warnedInsecureHttp = true;
      console.error(`WARNING: TAIGA_API_URL "${url}" uses unencrypted HTTP to a non-loopback host. Passwords and bearer tokens will be transmitted in cleartext.`);
    }
  }
  return url;
}

let token: string | null = null;
let tokenExpiresAt = 0;
let client: AxiosInstance | null = null;

/** True when credentials are available in the environment. */
export function isConfigured(): boolean {
  return Boolean(process.env.TAIGA_USERNAME && process.env.TAIGA_PASSWORD);
}

/**
 * Wrap an axios failure in an Error that keeps the HTTP status and Taiga's response body.
 * Taiga returns validation errors as `{ field: ["message"] }` and auth errors as
 * `{ _error_message: "..." }`; both are flattened into the message.
 */
function apiError(error: Error, action: string): ApiError {
  let status: number | undefined;
  let body: TaigaErrorBody | undefined;
  let detail = error.message;
  if (isAxiosError<TaigaErrorBody>(error)) {
    status = error.response?.status;
    body = error.response?.data;
  }
  // This IS the I/O boundary: `body` is whatever an arbitrary HTTP error carried — a Taiga
  // validation object, an HTML error page from a proxy, or nothing. Narrowing by `typeof` is the
  // check, not a shortcut around one, and a schema here would only guard a diagnostic string.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  if (body && typeof body === 'object') {
    detail = body._error_message
      || Object.entries(body)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('; ');
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- same boundary, string body branch
  } else if (typeof body === 'string' && body) {
    detail = body;
  }
  return Object.assign(new Error(`${action} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`), {
    status,
    detail: body,
  });
}

/**
 * Exchange credentials for an auth token.
 */
export async function login(username: string, password: string): Promise<AuthResponse> {
  try {
    const { data } = await axios.post<AuthResponse>(`${apiBaseUrl()}/auth`, { type: 'normal', username, password }, { timeout: REQUEST_TIMEOUT_MS });
    token = data.auth_token;
    // ponytail: fixed TTL instead of decoding the JWT; a 401 retry below covers early expiry.
    tokenExpiresAt = Date.now() + 12 * 60 * 60 * 1000;
    return data;
  } catch (error) {
    token = null;
    const err = error instanceof Error ? error : new Error(String(error));
    throw apiError(err, 'Authentication');
  }
}

async function getToken(): Promise<string> {
  if (token && Date.now() < tokenExpiresAt) return token;
  if (!isConfigured()) {
    throw new Error('Taiga credentials missing: set TAIGA_USERNAME and TAIGA_PASSWORD, or call the authenticate tool.');
  }
  await login(process.env.TAIGA_USERNAME ?? '', process.env.TAIGA_PASSWORD ?? '');
  if (!token) {
    throw new Error('Failed to acquire Taiga token');
  }
  return token;
}

function getClient(): AxiosInstance {
  if (client) return client;
  client = axios.create({
    baseURL: apiBaseUrl(),
    timeout: REQUEST_TIMEOUT_MS,
    // Return whole collections instead of the default 30-item first page.
    headers: { 'x-disable-pagination': 'true' },
  });
  client.interceptors.request.use(async (config) => {
    config.headers.Authorization = `Bearer ${await getToken()}`;
    return config;
  });
  return client;
}

/** Longest throttle wait worth blocking a tool call for; beyond this, report instead of sleeping. */
const MAX_THROTTLE_WAIT_MS = 5000;

/** `Retry-After` in seconds or as an HTTP date; null when absent or unparseable. */
function retryAfterMs(response?: AxiosResponse): number | null {
  const header = response?.headers?.['retry-after'];
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const when = Date.parse(String(header));
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

export interface RequestOptions {
  params?: QueryParams;
  data?: JsonBody | FormData;
  headers?: Record<string, string>;
  responseType?: 'json' | 'arraybuffer';
}

/**
 * Perform an API call and return the response body.
 *
 * Retries are deliberately narrow. A 401 means the cached token died, so re-authenticate once.
 * A 429 means the request was rejected without being processed, so it is safe to repeat for any
 * method — but only after the server's own `Retry-After`, and only if that wait is short enough
 * to be worth blocking on. 5xx is NOT retried: the request may have been applied, and silently
 * repeating a POST would duplicate work items.
 */
export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const config = { method, url: path, ...options };
  let throttleRetries = 2;
  for (;;) {
    try {
      return (await getClient().request<T>(config)).data;
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const status = isAxiosError(err) ? err.response?.status : undefined;

      if (status === 401 && token) {
        token = null;
        try {
          return (await getClient().request<T>(config)).data;
        } catch (retryError) {
          const retryErr = retryError instanceof Error ? retryError : new Error(String(retryError));
          throw apiError(retryErr, `${method} ${path}`);
        }
      }

      if (status === 429 && throttleRetries > 0) {
        const wait = isAxiosError(err) ? retryAfterMs(err.response) ?? 1000 : 1000;
        if (wait > MAX_THROTTLE_WAIT_MS) {
          throw Object.assign(
            new Error(`${method} ${path} was rate limited; retry in ${Math.ceil(wait / 1000)}s`),
            { status, detail: isAxiosError<TaigaErrorBody>(err) ? err.response?.data : undefined },
          );
        }
        throttleRetries -= 1;
        await sleep(wait);
        continue;
      }

      throw apiError(err, `${method} ${path}`);
    }
  }
}

export const get = <T>(path: string, params?: QueryParams): Promise<T> => request<T>('GET', path, { params });
export const post = <T>(path: string, data?: JsonBody): Promise<T> => request<T>('POST', path, { data });
export const patch = <T>(path: string, data?: JsonBody): Promise<T> => request<T>('PATCH', path, { data });
export const del = <T>(path: string, params?: QueryParams): Promise<T> => request<T>('DELETE', path, { params });

type CachedValue = TaigaProject | TaigaUser | TaigaTaxonomyItem[] | TaigaUser[];

interface CachedResponse {
  expires: number;
  value: CachedValue;
}

/** Project metadata is stable for the length of a session; work items are not. */
const METADATA_TTL_MS = 60_000;
const metadata = new Map<string, CachedResponse>();

/**
 * GET through a short-lived process cache.
 *
 * ONLY for project metadata that our own writes cannot change: members, statuses, priorities,
 * severities, issue types, project lookup by slug. NEVER for work items, comments or attachments —
 * a stale issue list is a wrong answer, whereas a stale status list is not, and the cache is what
 * keeps a single tool call from fetching /users twice and a session from refetching it per call.
 */
export async function getMetadata<T>(path: string, params?: QueryParams): Promise<T> {
  const key = `${path} ${JSON.stringify(params ?? {})}`;
  const hit = metadata.get(key);
  let value: CachedValue;
  if (hit && hit.expires > Date.now()) {
    value = hit.value;
  } else {
    const now = Date.now();
    for (const [k, entry] of metadata.entries()) {
      if (entry.expires <= now) {
        metadata.delete(k);
      }
    }
    value = await get<CachedValue>(path, params);
    metadata.set(key, { value, expires: Date.now() + METADATA_TTL_MS });
  }
  // SAFETY: caller's type parameter T must match the endpoint passed in path
  return value as T;
}

/** Drop cached metadata. Test hook, and an escape hatch after out-of-band project edits. */
export function clearMetadata(): void {
  metadata.clear();
}
