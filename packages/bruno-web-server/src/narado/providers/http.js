/**
 * Small JSON-over-HTTP helper for Git host APIs.
 * Errors carry the HTTP status and the host's message, never the token.
 */
class HostApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'HostApiError';
    this.status = status;
  }
}

const TIMEOUT_MS = 30 * 1000;
const RETRY_DELAYS_MS = [500, 2000]; // for reads only

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const requestJson = async (url, { method = 'GET', headers = {}, body, fetchImpl = globalThis.fetch, retryDelays = RETRY_DELAYS_MS } = {}) => {
  const init = {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  };
  // Reads are safe to repeat after a network failure; writes are not (a POST may have landed).
  const attempts = method === 'GET' ? retryDelays.length + 1 : 1;
  let res;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
      break;
    } catch (err) {
      if (attempt === attempts - 1) {
        const reason = err && err.cause && err.cause.code ? err.cause.code : err && err.name === 'TimeoutError' ? 'timed out' : err.message;
        throw new HostApiError(`Could not reach ${new URL(url).host} (${reason}). Check the server's network and try again.`, 0);
      }
      await sleep(retryDelays[attempt]);
    }
  }

  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!res.ok) {
    const detail
      = (data && typeof data === 'object' && (data.message || data.error_description || data.error))
        || (typeof data === 'string' ? data.slice(0, 200) : '')
        || res.statusText;
    const extra = data && Array.isArray(data.errors) ? ` (${data.errors.map((e) => e.message || e.code || JSON.stringify(e)).join('; ')})` : '';
    throw new HostApiError(`${method} ${new URL(url).pathname} failed: ${res.status} ${detail}${extra}`, res.status);
  }

  return { data, headers: res.headers };
};

module.exports = { requestJson, HostApiError };
