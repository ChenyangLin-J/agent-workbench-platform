export function resolveMinimalHostUrl(path, { baseUrl = globalThis.document?.baseURI } = {}) {
  if (typeof path !== 'string' || !path.trim()) throw new TypeError('Minimal Host path is required');
  if (!baseUrl) throw new TypeError('Minimal Host base URL is required');
  return new URL(path.replace(/^\/+/, ''), ensureDirectoryUrl(baseUrl)).toString();
}

function ensureDirectoryUrl(value) {
  const url = new URL(value, globalThis.location?.origin || 'http://localhost');
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`;
  url.search = '';
  url.hash = '';
  return url;
}
