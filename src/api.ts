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

export function isConfigured(): boolean {
  return Boolean(process.env.TAIGA_USERNAME && process.env.TAIGA_PASSWORD);
}

function isErrorBodyObject(body: TaigaErrorBody | undefined): body is Exclude<TaigaErrorBody, string> {
  return body !== undefined && Object(body) === body;
}

class FetchError extends Error {
  constructor(
    readonly status: number,
    readonly detail: TaigaErrorBody | undefined,
    readonly retryAfterMs: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

function buildApiUrl(path: string, params?: QueryParams): string {
  const base = new URL(apiBaseUrl());
  base.search = '';
  base.hash = '';
  if (!base.pathname.endsWith('/')) base.pathname += '/';
  const url = new URL(path.replace(/^\/+/, ''), base);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== null && value !== undefined) url.searchParams.append(key, String(value));
  }
  return url.toString();
}

async function parseResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

async function fetchData(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
}

function responseError(response: Response, detail: TaigaErrorBody | undefined): FetchError {
  const message = response.statusText || `Request failed with status code ${response.status}`;
  return new FetchError(response.status, detail, parseRetryAfter(response.headers.get('retry-after')), message);
}

function apiError(error: Error, action: string): ApiError {
  const fetchError = error instanceof FetchError ? error : undefined;
  const status = fetchError?.status;
  const body = fetchError?.detail;
  let detail = error.message;
  if (isErrorBodyObject(body)) {
    detail = body._error_message
      || Object.entries(body)
        .map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`)
        .join('; ');
  } else if (body) {
    detail = body;
  }
  return Object.assign(new Error(`${action} failed${status ? ` (HTTP ${status})` : ''}: ${detail}`), {
    status,
    detail: body,
  });
}

export async function login(username: string, password: string): Promise<AuthResponse> {
  try {
    const response = await fetchData(buildApiUrl('auth'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'normal', username, password }),
    });
    if (!response.ok) throw responseError(response, await parseResponse<TaigaErrorBody>(response));
    const data = await parseResponse<AuthResponse>(response);
    token = data.auth_token;
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

const MAX_THROTTLE_WAIT_MS = 5000;

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return seconds * 1000;
  const when = Date.parse(header);
  return Number.isFinite(when) ? Math.max(0, when - Date.now()) : null;
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => { setTimeout(resolve, ms); });
};

export interface RequestOptions {
  params?: QueryParams;
  data?: JsonBody | FormData;
  headers?: Record<string, string>;
}

async function fetchRequest<T>(method: string, path: string, options: RequestOptions): Promise<T> {
  const headers = new Headers(options.headers);
  headers.set('x-disable-pagination', 'true');
  headers.set('Authorization', `Bearer ${await getToken()}`);
  const init: RequestInit = { method, headers };
  if (options.data !== undefined) {
    if (options.data instanceof FormData) {
      headers.delete('Content-Type');
      init.body = options.data;
    } else {
      init.body = JSON.stringify(options.data);
      if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    }
  }
  const response = await fetchData(buildApiUrl(path, options.params), init);
  if (!response.ok) throw responseError(response, await parseResponse<TaigaErrorBody>(response));
  return parseResponse<T>(response);
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  let throttleRetries = 2;
  for (;;) {
    try {
      return await fetchRequest<T>(method, path, options);
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      const fetchError = err instanceof FetchError ? err : undefined;
      const status = fetchError?.status;

      if (status === 401 && token) {
        token = null;
        try {
          return await fetchRequest<T>(method, path, options);
        } catch (retryError) {
          const retryErr = retryError instanceof Error ? retryError : new Error(String(retryError));
          throw apiError(retryErr, `${method} ${path}`);
        }
      }

      if (status === 429 && throttleRetries > 0) {
        const wait = fetchError?.retryAfterMs ?? 1000;
        if (wait > MAX_THROTTLE_WAIT_MS) {
          throw Object.assign(
            new Error(`${method} ${path} was rate limited; retry in ${Math.ceil(wait / 1000)}s`),
            { status, detail: fetchError?.detail },
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

const METADATA_TTL_MS = 60_000;
const metadata = new Map<string, CachedResponse>();

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
  return value as T;
}

export function clearMetadata(): void {
  metadata.clear();
}
