const DEFAULT_RETRY_MIN_MS = 500;
const DEFAULT_RETRY_MAX_MS = 5_000;

export async function maintainMinimalHostEventStream({
  open,
  onEvent,
  signal,
  retryMinMs = DEFAULT_RETRY_MIN_MS,
  retryMaxMs = DEFAULT_RETRY_MAX_MS,
  wait = waitForRetry,
} = {}) {
  if (typeof open !== 'function') throw new TypeError('Event stream open function is required');
  if (typeof onEvent !== 'function') throw new TypeError('Event stream callback is required');
  if (!signal || typeof signal.aborted !== 'boolean') throw new TypeError('Event stream AbortSignal is required');
  const minimum = positiveDelay(retryMinMs, 'minimum retry delay');
  const maximum = positiveDelay(retryMaxMs, 'maximum retry delay');
  if (maximum < minimum) throw new TypeError('maximum retry delay must be at least the minimum retry delay');

  let afterEventId = 0;
  let retryDelayMs = minimum;
  while (!signal.aborted) {
    let receivedEvents = 0;
    try {
      const response = await open({ afterEventId, signal });
      if (!response?.ok || !response.body) {
        await response?.body?.cancel?.().catch(() => {});
        throw eventStreamError(response?.status);
      }
      const result = await readMinimalHostEventStream(response.body, {
        onEvent(event) {
          receivedEvents += 1;
          if (event.eventId != null) afterEventId = event.eventId;
          onEvent(event);
        },
      });
      if (result.lastEventId != null) afterEventId = result.lastEventId;
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') return;
    }

    if (signal.aborted) return;
    try {
      await wait(receivedEvents ? minimum : retryDelayMs, signal);
    } catch (error) {
      if (signal.aborted || error?.name === 'AbortError') return;
      throw error;
    }
    retryDelayMs = receivedEvents
      ? minimum
      : Math.min(maximum, retryDelayMs * 2);
  }
}

export async function readMinimalHostEventStream(body, { onEvent } = {}) {
  if (!body?.getReader) throw new TypeError('Readable event stream body is required');
  if (typeof onEvent !== 'function') throw new TypeError('Event stream callback is required');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines = [];
  let pendingEventId = null;
  let lastEventId = null;
  let eventCount = 0;

  function dispatch() {
    const normalizedId = eventIdentifier(pendingEventId);
    if (normalizedId != null) lastEventId = normalizedId;
    if (dataLines.length) {
      const data = dataLines.join('\n');
      onEvent({ eventId: normalizedId ?? lastEventId, data });
      eventCount += 1;
    }
    dataLines = [];
    pendingEventId = null;
  }

  function consumeLine(rawLine) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (!line) {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    const separator = line.indexOf(':');
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? '' : line.slice(separator + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'id') pendingEventId = value;
    else if (field === 'data') dataLines.push(value);
  }

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) consumeLine(line);
    }
    buffer += decoder.decode();
    if (buffer) consumeLine(buffer);
    dispatch();
    return { eventCount, lastEventId };
  } finally {
    reader.releaseLock?.();
  }
}

function waitForRetry(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(finish, delayMs);
    signal.addEventListener('abort', abort, { once: true });
    function finish() {
      signal.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(abortError());
    }
  });
}

function eventIdentifier(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function eventStreamError(status) {
  const error = new Error(`Event stream failed (${Number(status) || 'unknown'})`);
  error.code = 'MINIMAL_HOST_EVENT_STREAM_FAILED';
  return error;
}

function abortError() {
  const error = new Error('Event stream aborted');
  error.name = 'AbortError';
  return error;
}

function positiveDelay(value, label) {
  const normalized = Number(value);
  if (!Number.isFinite(normalized) || normalized <= 0) throw new TypeError(`${label} must be positive`);
  return normalized;
}
