import { maintainMinimalHostEventStream } from './host-event-stream.js';
import { applyMinimalHostSessionEvent, parseMinimalHostSessionEvent, patchMinimalHostSessionSummary } from './host-session-events.js';
import { minimalHostSessionPresentation } from './host-presentation.js';

/** Minimal Host's HTTP/event-stream adapter; the common Host Kit owns client state. */
export function createMinimalHostAdapter({ request, openEvents, presentSession = minimalHostSessionPresentation, pageSize = 50, conversationTurns = 5 }) {
  return {
    async listSessions({ cursor = null, archived = false, query = '', signal } = {}) {
      const params = new URLSearchParams({ limit: String(pageSize) });
      if (cursor) params.set('cursor', cursor);
      if (archived) params.set('includeArchived', '1');
      if (query) params.set('query', query);
      const body = await request(`api/sessions?${params}`, { signal });
      return { ...body, sessions: (body.sessions || []).map(minimalHostSessionPresentation) };
    },
    async readSession(id, { signal } = {}) {
      const body = await request(`api/sessions/${encodeURIComponent(id)}?view=conversation&turnLimit=${conversationTurns}`, { signal });
      const session = body.session;
      if (['running', 'waiting'].includes(session.status) && session.access?.kind !== 'shared') {
        const key = session.turnMetadata?.at(-1)?.turnKey;
        if (key) {
          const details = await request(`api/sessions/${encodeURIComponent(id)}/turns/${encodeURIComponent(key)}/technical-items`, { signal });
          session.technicalItems = details.technicalItems || [];
        }
      }
      return presentSession(session);
    },
    async createSession(payload, { idempotencyKey }) {
      return request('api/sessions', { method: 'POST', headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(payload) });
    },
    async execute(id, action, payload, { idempotencyKey }) {
      const routes = { turn: ['turns', 'POST'], interrupt: ['interrupt', 'POST'], profile: ['execution-profile', 'PATCH'], branch: ['branches', 'POST'], archive: ['archive', 'PATCH'], favorite: ['favorite', 'PATCH'] };
      const route = routes[action];
      if (!route) throw new Error(`Unsupported Minimal Host operation: ${action}`);
      return request(`api/sessions/${encodeURIComponent(id)}/${route[0]}`, { method: route[1], headers: { 'idempotency-key': idempotencyKey }, body: JSON.stringify(payload) });
    },
    async loadHistory(id, { cursor, limit = 10 } = {}) {
      const body = await request(`api/sessions/${encodeURIComponent(id)}?view=conversation&turnLimit=${limit}&turnCursor=${encodeURIComponent(cursor)}`);
      return presentSession(body.session);
    },
    subscribeSession(id, { signal, onEvent, onConnection, afterRevision }) {
      void maintainMinimalHostEventStream({
        open: ({ afterEventId, signal: streamSignal }) => openEvents(id, { afterEventId, signal: streamSignal }),
        onEvent: (envelope) => {
          const event = parseMinimalHostSessionEvent(envelope);
          if (!event) return;
          const media = event.payload?.item?.publishedMedia;
          onEvent(media?.resourceId ? { ...event, payload: { ...event.payload, item: { ...event.payload.item,
            publishedMedia: { ...media, id: media.resourceId, kind: 'image', alt: media.name || '图片', attachmentId: media.resourceId },
          } } } : event);
        },
        onState: onConnection,
        signal,
        initialEventId: afterRevision,
      }).catch((error) => { if (error.name !== 'AbortError') onConnection({ status: 'disconnected', error: error.message }); });
      // Cancellation is owned by the Host Kit's AbortSignal.
      return () => {};
    },
    applyEvent: (session, event) => {
      const applied = applyMinimalHostSessionEvent(session, event);
      return applied.snapshotRequired ? applied : applied.session ? presentSession(applied.session) : session;
    },
    patchSummary: patchMinimalHostSessionSummary,
  };
}
