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

const requestJson = async (url, { method = 'GET', headers = {}, body, fetchImpl = globalThis.fetch } = {}) => {
  const res = await fetchImpl(url, {
    method,
    headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined
  });

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
