import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SessionClientOperationController } from '../session-client.js';
import { SessionBrowser } from '../ui/index.jsx';
import { sessionMessageBranchEligibility } from '../features/session-branch.js';
import { maintainMinimalHostEventStream } from './host-event-stream.js';
import {
  applyMinimalHostSessionEvent,
  parseMinimalHostSessionEvent,
  patchMinimalHostSessionSummary,
} from './host-session-events.js';
import {
  minimalHostSessionPresentation,
  selectMinimalHostSession,
  shouldAutoCreateMinimalHostSession,
} from './host-presentation.js';
import { resolveMinimalHostUrl } from './host-url.js';
import '../ui/styles.css';
import './assets/host.css';

const bootstrap = globalThis.__AGENT_WORKBENCH_BOOTSTRAP__ || {};
const hostBaseUrl = bootstrap.baseUrl || globalThis.document?.baseURI;
const attachmentsEnabled = bootstrap.features?.attachments === true;
const steerEnabled = featureEnabled('steer') && bootstrap.runtimeCapabilities?.steer !== false;
const messageEditEnabled = featureEnabled('messageEdit');
const messageForkEnabled = featureEnabled('messageFork') && bootstrap.runtimeCapabilities?.fork !== false;
const queuedTurnsEnabled = featureEnabled('queuedTurns');
const sessionSharing = bootstrap.sessionSharing?.enabled === true ? bootstrap.sessionSharing : null;
const startsWithNewSession = bootstrap.sessionStart === 'new';
const initialSessionId = new URLSearchParams(globalThis.location?.search || '').get('session');
const SHARED_SESSION_POLL_MS = 5_000;
const OWNED_ACTIVE_SESSION_POLL_MS = 2_000;
const SESSION_LIST_PAGE_SIZE = 50;
const INITIAL_CONVERSATION_TURNS = 5;
const HISTORY_CONVERSATION_TURNS = 10;

function hostUrl(path) {
  return resolveMinimalHostUrl(path, { baseUrl: hostBaseUrl });
}

function MinimalHostApp() {
  const [sessions, setSessions] = useState([]);
  const [sessionsLoaded, setSessionsLoaded] = useState(false);
  const [sessionsLoadingMore, setSessionsLoadingMore] = useState(false);
  const [listPagination, setListPagination] = useState({ ownedCursor: null, sharedOffset: null });
  const [selectedId, setSelectedId] = useState(initialSessionId);
  const selectedIdRef = useRef(initialSessionId);
  const [session, setSession] = useState(null);
  const activeSessionRef = useRef(null);
  const terminalRecheckTimer = useRef(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [streamNotice, setStreamNotice] = useState('');
  const [continuing, setContinuing] = useState(false);
  const [documentPreview, setDocumentPreview] = useState(null);
  const continuationKey = useRef(null);
  const documentPreviewUrl = useRef(null);
  const documentPreviewRequest = useRef(null);
  const sessionMediaUrls = useRef({ sessionId: null, entries: new Map() });
  const openedShares = useRef(new Set());
  const detailRequest = useRef({ controller: null, generation: 0 });
  const technicalRequests = useRef(new Map());
  const listRequestGeneration = useRef(0);
  const eventFrame = useRef(null);
  const pendingEvents = useRef([]);
  const operationController = useRef(null);
  const automaticSessionCreationAttempted = useRef(false);
  operationController.current ||= new SessionClientOperationController();

  const closeDocumentPreview = useCallback(() => {
    documentPreviewRequest.current?.abort();
    documentPreviewRequest.current = null;
    setDocumentPreview(null);
    if (documentPreviewUrl.current) URL.revokeObjectURL(documentPreviewUrl.current);
    documentPreviewUrl.current = null;
  }, []);

  const clearSessionMediaUrls = useCallback((sessionId = null) => {
    if (sessionId && sessionMediaUrls.current.sessionId !== sessionId) return;
    for (const entry of sessionMediaUrls.current.entries.values()) {
      entry.controller?.abort();
      if (entry.url) URL.revokeObjectURL(entry.url);
    }
    sessionMediaUrls.current = { sessionId: null, entries: new Map() };
  }, []);

  const loadSessionMediaUrl = useCallback(async (sessionId, media, { signal = null } = {}) => {
    const resourceId = String(media?.resourceId || media?.attachmentId || '').trim();
    if (!sessionId || !resourceId) return String(media?.src || '');
    if (signal?.aborted) throw abortError();
    if (sessionMediaUrls.current.sessionId !== sessionId) {
      clearSessionMediaUrls();
      sessionMediaUrls.current.sessionId = sessionId;
    }
    const cached = sessionMediaUrls.current.entries.get(resourceId);
    if (cached) return cached.promise;
    const controller = new AbortController();
    const entry = { controller, promise: null, url: '' };
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    entry.promise = fetch(hostUrl(
      `api/sessions/${encodeURIComponent(sessionId)}/attachments/${encodeURIComponent(resourceId)}/content`,
    ), {
      headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error(`图片读取失败 (${response.status})`);
      const blob = await response.blob();
      if (!String(blob.type || media.mimeType || '').toLowerCase().startsWith('image/')) {
        throw new Error('资源不是可预览图片');
      }
      const url = URL.createObjectURL(blob);
      if (sessionMediaUrls.current.sessionId !== sessionId
        || sessionMediaUrls.current.entries.get(resourceId) !== entry) {
        URL.revokeObjectURL(url);
        return '';
      }
      entry.url = url;
      return url;
    }).catch((error) => {
      if (sessionMediaUrls.current.entries.get(resourceId) === entry) {
        sessionMediaUrls.current.entries.delete(resourceId);
      }
      throw error;
    }).finally(() => {
      signal?.removeEventListener('abort', abort);
    });
    sessionMediaUrls.current.entries.set(resourceId, entry);
    return entry.promise;
  }, [clearSessionMediaUrls]);

  const presentSession = useCallback((value) => minimalHostSessionPresentation(value), []);

  const request = useCallback(async (path, options = {}) => {
    const response = await fetch(hostUrl(path), {
      ...options,
      headers: {
        'content-type': 'application/json',
        'x-agent-workbench-token': bootstrap.accessToken || '',
        ...(options.headers || {}),
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
    return body;
  }, []);

  const selectSessionId = useCallback((nextValue) => {
    const next = typeof nextValue === 'function'
      ? nextValue(selectedIdRef.current)
      : nextValue;
    selectedIdRef.current = next;
    setSession((current) => (current?.sessionId === next ? current : null));
    setSelectedId(next);
  }, []);

  const productRequest = useCallback(async (path, options = {}) => {
    if (!sessionSharing?.apiBase) throw new Error('共享服务未配置。');
    const base = String(sessionSharing.apiBase).replace(/\/$/, '');
    const target = `${base}/${String(path).replace(/^\//, '')}`;
    const response = await fetch(target, {
      ...options,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
    return body;
  }, []);

  const refreshSessions = useCallback(async () => {
    const generation = ++listRequestGeneration.current;
    const first = await request(`api/sessions?limit=${SESSION_LIST_PAGE_SIZE}`);
    if (generation !== listRequestGeneration.current) return null;
    const nextSessions = mergeSessionSummaries([], first.sessions || []);
    setSessions(nextSessions);
    setListPagination({
      ownedCursor: first.nextCursor || null,
      sharedOffset: first.sharedNextOffset ?? null,
    });
    setSessionsLoaded(true);
    selectSessionId((current) => selectMinimalHostSession(nextSessions, current, { fallback: 'newest' }));
    return nextSessions;
  }, [request, selectSessionId]);

  const loadMoreSessions = useCallback(async () => {
    if (sessionsLoadingMore || (!listPagination.ownedCursor && listPagination.sharedOffset == null)) return;
    setSessionsLoadingMore(true);
    const ownedCursor = listPagination.ownedCursor;
    const sharedOffset = listPagination.sharedOffset;
    try {
      const [owned, shared] = await Promise.all([
        ownedCursor
          ? request(`api/sessions?shared=0&limit=${SESSION_LIST_PAGE_SIZE}&cursor=${encodeURIComponent(ownedCursor)}`)
          : null,
        sharedOffset != null
          ? request(`api/sessions?owned=0&sharedOffset=${encodeURIComponent(sharedOffset)}`)
          : null,
      ]);
      if (ownedCursor && owned?.nextCursor === ownedCursor) throw new Error('对话分页游标未前进。');
      if (sharedOffset != null && shared?.sharedNextOffset === sharedOffset) {
        throw new Error('共享对话分页未前进。');
      }
      setSessions((current) => mergeSessionSummaries(
        current,
        [...(owned?.sessions || []), ...(shared?.sessions || [])],
      ));
      setListPagination({
        ownedCursor: owned ? owned.nextCursor || null : null,
        sharedOffset: shared ? shared.sharedNextOffset ?? null : null,
      });
    } catch (nextError) {
      setError(nextError.message);
      throw nextError;
    } finally {
      setSessionsLoadingMore(false);
    }
  }, [listPagination, request, sessionsLoadingMore]);

  const refreshSession = useCallback(async (sessionId = selectedIdRef.current) => {
    if (!sessionId) return null;
    detailRequest.current.controller?.abort();
    const controller = new AbortController();
    const generation = detailRequest.current.generation + 1;
    detailRequest.current = { controller, generation };
    const body = await request(
      `api/sessions/${encodeURIComponent(sessionId)}?view=conversation&turnLimit=${INITIAL_CONVERSATION_TURNS}`,
      { signal: controller.signal },
    );
    if (detailRequest.current.generation !== generation) return null;
    if (selectedIdRef.current !== sessionId) return null;
    const nextSession = messageActionPresentation(presentSession(body.session));
    if (detailRequest.current.generation !== generation || selectedIdRef.current !== sessionId) {
      clearSessionMediaUrls(sessionId);
      return null;
    }
    setSession((current) => current?.sessionId === sessionId
      ? messageActionPresentation(mergeConversationRefresh(current, nextSession))
      : nextSession);
    return nextSession;
  }, [clearSessionMediaUrls, presentSession, request]);

  const loadEarlierTurns = useCallback(async () => {
    const current = session;
    if (!selectedId || !current?.hasEarlierTurns || !current.turnsCursor || current.historyLoading) return;
    setSession((value) => value?.sessionId === selectedId ? { ...value, historyLoading: true } : value);
    try {
      const body = await request(
        `api/sessions/${encodeURIComponent(selectedId)}?view=conversation&turnLimit=${HISTORY_CONVERSATION_TURNS}&turnCursor=${encodeURIComponent(current.turnsCursor)}`,
      );
      const page = messageActionPresentation(presentSession(body.session));
      setSession((value) => value?.sessionId === selectedId
        ? messageActionPresentation(mergeEarlierConversation(value, page))
        : value);
    } catch (nextError) {
      setSession((value) => value?.sessionId === selectedId ? { ...value, historyLoading: false } : value);
      setError(nextError.message);
      throw nextError;
    }
  }, [presentSession, request, selectedId, session]);

  const loadTechnicalDetails = useCallback(async (turnKey) => {
    const key = String(turnKey || '');
    if (!selectedId || !key || technicalRequests.current.has(key)) return;
    if (session?.technicalItems?.some((item) => (item.turnKey || item.turnId) === key)) return;
    const controller = new AbortController();
    technicalRequests.current.set(key, controller);
    setSession((value) => value?.sessionId === selectedId ? { ...value, technicalDetailsLoading: true } : value);
    try {
      const body = await request(
        `api/sessions/${encodeURIComponent(selectedId)}/turns/${encodeURIComponent(key)}/technical-items`,
        { signal: controller.signal },
      );
      setSession((value) => value?.sessionId === selectedId ? {
        ...value,
        technicalItems: mergeById(value.technicalItems, body.technicalItems),
        technicalDetailsLoading: false,
      } : value);
    } catch (nextError) {
      if (nextError.name !== 'AbortError') {
        setSession((value) => value?.sessionId === selectedId
          ? { ...value, technicalDetailsLoading: false }
          : value);
        setError(nextError.message);
        throw nextError;
      }
    } finally {
      technicalRequests.current.delete(key);
    }
  }, [request, selectedId, session?.technicalItems]);

  const resolveSessionMedia = useCallback((media, { sessionId = selectedIdRef.current, signal = null } = {}) => (
    loadSessionMediaUrl(sessionId, media, { signal })
  ), [loadSessionMediaUrl]);

  useEffect(() => {
    const sessionId = session?.sessionId;
    if (!sessionId) return undefined;
    if (['running', 'waiting'].includes(session.status)) {
      activeSessionRef.current = sessionId;
      return undefined;
    }
    if (activeSessionRef.current !== sessionId) return undefined;
    activeSessionRef.current = null;
    clearTimeout(terminalRecheckTimer.current);
    terminalRecheckTimer.current = setTimeout(() => {
      if (selectedIdRef.current !== sessionId) return;
      refreshSession(sessionId).catch((nextError) => {
        if (nextError.name !== 'AbortError') setError(nextError.message);
      });
    }, 350);
    return () => clearTimeout(terminalRecheckTimer.current);
  }, [refreshSession, session?.sessionId, session?.status]);

  useEffect(() => {
    closeDocumentPreview();
    for (const controller of technicalRequests.current.values()) controller.abort();
    technicalRequests.current.clear();
    clearSessionMediaUrls();
    return () => {
      closeDocumentPreview();
      for (const controller of technicalRequests.current.values()) controller.abort();
      technicalRequests.current.clear();
      clearSessionMediaUrls();
    };
  }, [clearSessionMediaUrls, closeDocumentPreview, selectedId]);

  const selectedSessionLoaded = session?.sessionId === selectedId;
  const selectedShared = selectedSessionLoaded
    ? session?.access?.kind === 'shared'
    : sessions.find((candidate) => candidate.id === selectedId)?.access?.kind === 'shared';

  useEffect(() => {
    if (!selectedId || !selectedSessionLoaded || selectedShared
      || !['running', 'waiting'].includes(session?.status)) return undefined;
    const timer = setInterval(() => {
      refreshSession(selectedId).catch((nextError) => {
        if (nextError.name !== 'AbortError') setError(nextError.message);
      });
    }, OWNED_ACTIVE_SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [refreshSession, selectedId, selectedSessionLoaded, selectedShared, session?.status]);

  useEffect(() => {
    refreshSessions().catch((nextError) => setError(nextError.message));
  }, [refreshSessions]);

  useEffect(() => {
    if (!selectedId) {
      setSession(null);
      return undefined;
    }
    if (!selectedSessionLoaded) {
      refreshSession(selectedId).catch((nextError) => {
        if (nextError.name !== 'AbortError') setError(nextError.message);
      });
      return () => detailRequest.current.controller?.abort();
    }
    if (selectedShared) {
      const timer = setInterval(() => {
        refreshSession(selectedId).catch((nextError) => {
          if (nextError.name !== 'AbortError') setError(nextError.message);
        });
      }, SHARED_SESSION_POLL_MS);
      return () => {
        clearInterval(timer);
        detailRequest.current.controller?.abort();
      };
    }
    const controller = new AbortController();
    let recoveryRefreshTimer = null;
    let recoveryRefreshRunning = false;
    let lastRecoveryRefreshAt = 0;
    const scheduleRecoveryRefresh = () => {
      if (recoveryRefreshTimer || recoveryRefreshRunning) return;
      const wait = Math.max(0, 2_000 - (Date.now() - lastRecoveryRefreshAt));
      recoveryRefreshTimer = setTimeout(async () => {
        recoveryRefreshTimer = null;
        recoveryRefreshRunning = true;
        try {
          await refreshSession(selectedId);
          lastRecoveryRefreshAt = Date.now();
        } catch (nextError) {
          if (nextError.name !== 'AbortError') setError(nextError.message);
        } finally {
          recoveryRefreshRunning = false;
        }
      }, wait);
    };
    void maintainMinimalHostEventStream({
      open: ({ afterEventId, signal }) => fetch(hostUrl(
        `api/sessions/${encodeURIComponent(selectedId)}/events?after=${encodeURIComponent(afterEventId)}`,
      ), {
        headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' },
        signal,
      }),
      onEvent: (envelope) => {
        const event = parseMinimalHostSessionEvent(envelope);
        if (!event || event.sessionId !== selectedIdRef.current) return;
        if (event.type === 'replay_gap' || event.payload?.snapshotRequired === true) {
          setStreamNotice('正在恢复此对话…');
          refreshSession(event.sessionId)
            .then(() => setStreamNotice(''))
            .catch((nextError) => {
              if (nextError.name !== 'AbortError') setError(nextError.message);
            });
          return;
        }
        const flushEvents = () => {
          eventFrame.current = null;
          const projectedEvents = pendingEvents.current.splice(0);
          if (!projectedEvents.length) return;
          setSession((current) => {
            let next = current;
            for (const projectedEvent of projectedEvents) {
              const applied = applyMinimalHostSessionEvent(next, projectedEvent);
              if (applied.session) next = applied.session;
            }
            return next === current ? current : messageActionPresentation(next);
          });
          setSessions((currentSessions) => {
            let next = currentSessions;
            for (const projectedEvent of projectedEvents) {
              const currentSummary = next.find((candidate) => (
                (candidate.id || candidate.sessionId) === projectedEvent.sessionId
              ));
              if (!currentSummary) continue;
              const applied = applyMinimalHostSessionEvent(currentSummary, projectedEvent);
              if (applied.session) next = patchMinimalHostSessionSummary(next, applied.session);
            }
            return next;
          });
        };
        const publishedMedia = event.payload?.item?.publishedMedia;
        pendingEvents.current.push(publishedMedia?.resourceId ? {
          ...event,
          payload: { ...event.payload, item: {
            ...event.payload.item,
            publishedMedia: {
              ...publishedMedia,
              id: publishedMedia.resourceId,
              kind: 'image',
              alt: publishedMedia.name || '图片',
              attachmentId: publishedMedia.resourceId,
            },
          } },
        } : event);
        if (eventFrame.current == null) {
          eventFrame.current = typeof requestAnimationFrame === 'function'
            ? requestAnimationFrame(flushEvents)
            : setTimeout(flushEvents, 16);
        }
      },
      onState: ({ status }) => {
        if (status === 'connected') {
          setStreamNotice('');
          return;
        }
        setStreamNotice('正在重连…');
        scheduleRecoveryRefresh();
      },
      signal: controller.signal,
    }).catch((nextError) => {
      if (nextError.name !== 'AbortError') setError(nextError.message);
    });
    return () => {
      controller.abort();
      detailRequest.current.controller?.abort();
      if (eventFrame.current != null) {
        if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(eventFrame.current);
        else clearTimeout(eventFrame.current);
        eventFrame.current = null;
      }
      pendingEvents.current = [];
      clearTimeout(recoveryRefreshTimer);
    };
  }, [refreshSession, selectedId, selectedSessionLoaded, selectedShared]);

  useEffect(() => {
    const shareId = session?.access?.kind === 'shared' ? session.access.shareId : null;
    if (!shareId || openedShares.current.has(shareId) || !sessionSharing) return;
    openedShares.current.add(shareId);
    void productRequest(`session-shares/${encodeURIComponent(shareId)}/opened`, {
      method: 'POST', body: '{}',
    }).catch(() => openedShares.current.delete(shareId));
  }, [session?.access?.kind, session?.access?.shareId, productRequest]);

  async function createSession() {
    setError('');
    const operation = operationController.current.begin({
      scope: 'session-create',
      targetId: 'new',
      payload: {},
    });
    try {
      const body = await request('api/sessions', {
        method: 'POST',
        headers: { 'idempotency-key': operation.idempotencyKey },
        body: JSON.stringify(operation.payload),
      });
      operationController.current.complete(operation);
      selectSessionId(body.session.sessionId);
      await refreshSessions();
    } catch (nextError) {
      setError(nextError.message);
    }
  }

  useEffect(() => {
    if (!shouldAutoCreateMinimalHostSession({
      creationAttempted: automaticSessionCreationAttempted.current,
      initialSessionId,
      selectedId,
      sessions,
      sessionsLoaded,
      startsWithNewSession,
    })) return;
    automaticSessionCreationAttempted.current = true;
    void createSession();
  }, [selectedId, sessions.length, sessionsLoaded]);

  async function continueSharedSession() {
    if (!selectedId || continuing) return;
    setError('');
    setNotice('');
    setContinuing(true);
    continuationKey.current ||= globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    const sourceShareId = session?.access?.shareId;
    try {
      const body = await request(`api/sessions/${encodeURIComponent(selectedId)}/continue`, {
        method: 'POST',
        headers: { 'idempotency-key': continuationKey.current },
        body: JSON.stringify({}),
      });
      continuationKey.current = null;
      const nextSession = messageActionPresentation(minimalHostSessionPresentation(body.session));
      selectSessionId(nextSession.sessionId);
      setSession(nextSession);
      await refreshSessions();
      await refreshSession(nextSession.sessionId);
      setNotice('已创建副本，可以继续提问。');
      if (sourceShareId && sessionSharing) {
        void productRequest(`session-shares/${encodeURIComponent(sourceShareId)}/forked`, {
          method: 'POST', body: JSON.stringify({ targetSessionId: nextSession.sessionId }),
        }).catch(() => {});
      }
    } catch (nextError) {
      setError(nextError.message);
    } finally {
      setContinuing(false);
    }
  }

  async function submit({ prompt, mode, attachments = [] }) {
    setError('');
    const operation = operationController.current.begin({
      scope: 'turn',
      targetId: selectedId,
      payload: { prompt, mode, attachments },
    });
    try {
      const result = await request(`api/sessions/${encodeURIComponent(selectedId)}/turns`, {
        method: 'POST',
        headers: { 'idempotency-key': operation.idempotencyKey },
        body: JSON.stringify(operation.payload),
      });
      if (result.idempotent && result.pending) {
        throw new Error('这条消息仍在确认中，请稍后重试。');
      }
      operationController.current.complete(operation);
      if (result.queued && result.queuedTurn) {
        setSession((current) => current ? {
          ...current,
          queuedTurns: [...(current.queuedTurns || []), result.queuedTurn],
        } : current);
      } else {
        await refreshSession(selectedId);
      }
      setSession((current) => current ? { ...current, status: 'running', statusLabel: '正在处理' } : current);
    } catch (nextError) {
      setError(nextError.message);
      throw nextError;
    }
  }

  async function uploadAttachments(files, options = {}) {
    if (!selectedId) throw new Error('请先新建或选择一个对话。');
    return uploadSessionAttachments(selectedId, files, options);
  }

  async function resolveDroppedDirectories({ directories = [] } = {}) {
    if (!selectedId) throw new Error('请先新建或选择一个对话。');
    return request(`api/sessions/${encodeURIComponent(selectedId)}/directory-references`, {
      method: 'POST',
      body: JSON.stringify({
        directories: directories.map(({ name, pathHint }) => ({ name, pathHint })),
      }),
    });
  }

  async function openAttachment(attachment) {
    if (!selectedId || !attachment) return;
    if (attachment.kind === 'image' && attachment.previewUrl) {
      closeDocumentPreview();
      setDocumentPreview({
        name: attachment.name || '图片',
        format: 'image',
        mimeType: attachment.mimeType || 'image/*',
        size: attachment.size || 0,
        src: attachment.previewUrl,
        downloadUrl: attachment.previewUrl,
        attachmentId: attachment.id || null,
      });
      return;
    }
    if (!attachment.id) return;
    const openingSessionId = selectedId;
    documentPreviewRequest.current?.abort();
    const controller = new AbortController();
    documentPreviewRequest.current = controller;
    const sourceLabel = attachment.resource?.kind === 'session-artifact' ? 'Agent 产物' : 'Session 附件';
    setDocumentPreview({
      name: attachment.name || '附件',
      format: 'text',
      mimeType: attachment.mimeType || 'application/octet-stream',
      size: attachment.size || 0,
      attachmentId: attachment.id,
      resource: attachment.resource || null,
      sourceLabel,
      loading: true,
    });
    try {
      const response = await fetch(hostUrl(
        `api/sessions/${encodeURIComponent(openingSessionId)}/attachments/${encodeURIComponent(attachment.id)}/preview`,
      ), {
        headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' },
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error?.message || `附件读取失败 (${response.status})`);
      if (selectedIdRef.current !== openingSessionId || documentPreviewRequest.current !== controller) return;
      setDocumentPreview({
        ...body,
        attachmentId: attachment.id,
        resource: attachment.resource || null,
        sourceLabel,
        loading: false,
      });
    } catch (nextError) {
      if (nextError?.name === 'AbortError') return;
      if (selectedIdRef.current !== openingSessionId || documentPreviewRequest.current !== controller) return;
      setDocumentPreview((current) => ({
        ...(current || {}),
        loading: false,
        previewError: { message: nextError?.message || '附件预览失败。' },
      }));
    } finally {
      if (documentPreviewRequest.current === controller) documentPreviewRequest.current = null;
    }
  }

  async function downloadAttachment(file) {
    if (!selectedId || !file?.attachmentId) return;
    const response = await fetch(hostUrl(
      `api/sessions/${encodeURIComponent(selectedId)}/attachments/${encodeURIComponent(file.attachmentId)}/content`,
    ), { headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' } });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || `附件下载失败 (${response.status})`);
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    const link = document.createElement('a');
    link.href = objectUrl;
    link.download = file.name || 'download';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1_000);
  }

  async function interrupt() {
    const expectedTurnId = session?.runtimeBinding?.activeTurnId;
    if (!expectedTurnId) return;
    await request(`api/sessions/${encodeURIComponent(selectedId)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify({ expectedTurnId }),
    });
  }

  async function branchMessage({ turnId, prompt }, intent) {
    setError('');
    try {
      const body = await request(`api/sessions/${encodeURIComponent(selectedId)}/branches`, {
        method: 'POST',
        body: JSON.stringify({
          replaceTurnId: turnId,
          ...(intent === 'edit' ? { prompt } : {}),
          intent,
        }),
      });
      const nextSession = messageActionPresentation(minimalHostSessionPresentation(body.session));
      selectSessionId(nextSession.sessionId);
      setSession(nextSession);
      await refreshSessions();
      await refreshSession(nextSession.sessionId);
      return nextSession;
    } catch (nextError) {
      setError(nextError.message);
      throw nextError;
    }
  }

  async function deleteQueuedTurn(queuedTurnId) {
    await request(`api/sessions/${encodeURIComponent(selectedId)}/queued-turns/${encodeURIComponent(queuedTurnId)}`, {
      method: 'DELETE',
    });
    await refreshSession(selectedId);
  }

  async function respondToRequest({ token, decision, answers }) {
    await request(`api/sessions/${encodeURIComponent(selectedId)}/requests/${encodeURIComponent(token)}`, {
      method: 'POST',
      body: JSON.stringify({ response: answers ? { answers } : { decision } }),
    });
  }

  const sharedReadOnly = session?.access?.kind === 'shared';
  const sessionMutable = !session?.runtimeContinuationRequired && !sharedReadOnly;
  const sessionBranchable = !sharedReadOnly;
  const detail = useMemo(() => session ? {
    session,
    documentPreview,
    features: {
      attachments: attachmentsEnabled ? 'visible' : 'hidden',
      externalLink: false,
      realtime: false,
      sessionStatus: false,
      sideChats: false,
      steer: steerEnabled,
      messageEdit: messageEditEnabled,
      messageFork: messageForkEnabled,
      queuedTurns: queuedTurnsEnabled,
      subagents: false,
      technicalDetails: true,
    },
    actions: {
      onSubmit: sessionMutable ? submit : null,
      onUploadAttachments: attachmentsEnabled && sessionMutable ? uploadAttachments : null,
      onResolveDroppedDirectories: attachmentsEnabled && sessionMutable ? resolveDroppedDirectories : null,
      onOpenAttachment: attachmentsEnabled ? openAttachment : null,
      onResolveMedia: attachmentsEnabled ? resolveSessionMedia : null,
      onCloseDocument: closeDocumentPreview,
      onDownloadDocument: attachmentsEnabled ? downloadAttachment : null,
      onInterrupt: sessionMutable && session.status === 'running' ? interrupt : null,
      onEditMessage: messageEditEnabled && sessionBranchable ? (input) => branchMessage(input, 'edit') : null,
      onForkMessage: messageForkEnabled && sessionBranchable ? (input) => branchMessage(input, 'fork') : null,
      onDeleteQueuedTurn: queuedTurnsEnabled && sessionMutable ? deleteQueuedTurn : null,
      onRespondToRequest: sessionMutable ? respondToRequest : null,
      onLoadEarlier: loadEarlierTurns,
      onLoadTechnicalDetails: loadTechnicalDetails,
      onError: (nextError) => setError(nextError.message),
    },
    labels: {
      composerPlaceholder: sessionMutable ? '输入问题……' : '当前对话为只读',
      emptyTitle: '开始对话',
      emptyBody: '直接输入问题即可开始。',
    },
    extensions: {
      renderHeaderActions: () => sharedReadOnly ? <>
        <span className="awb-shared-badge">只读</span>
        <button className="cwu-button awb-continue-button" disabled={continuing} onClick={continueSharedSession} type="button">
          {continuing ? '正在创建…' : '继续聊'}
        </button>
      </> : sessionSharing ? <SessionShareControl request={productRequest} sessionId={session.sessionId} /> : null,
      renderComposerReplacement: sharedReadOnly ? () => (
        <div className="awb-readonly-composer" role="status">
          <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
            <rect height="10" rx="2" width="14" x="5" y="10" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
          <span>此对话只读 · 点击右上角“继续聊”后可输入</span>
        </div>
      ) : null,
    },
  } : null, [session, documentPreview, selectedId, sessionMutable, sessionBranchable, sharedReadOnly, continuing, productRequest, loadEarlierTurns, loadTechnicalDetails, resolveSessionMedia]);

  const runtimeError = session?.status === 'error'
    ? userFacingRuntimeError(session.runtimeBinding?.lastError)
    : '';
  const visibleError = error || runtimeError;

  return (
    <main className="awb-minimal-host">
      <SessionBrowser
        actions={{
          onCreate: createSession,
          onSelect: (nextSession) => selectSessionId(nextSession.id),
          onToggleList: setListCollapsed,
          onLoadMore: loadMoreSessions,
        }}
        browser={{
          sessions,
          selectedSessionId: selectedId,
          listCollapsed,
          hasMore: Boolean(listPagination.ownedCursor || listPagination.sharedOffset != null),
          loadingMore: sessionsLoadingMore,
          paginationMode: 'incremental',
          groupMode: 'time',
          groupOptions: [{ id: 'time', label: '最近' }],
          createTargets: [{ id: 'environment', label: '对话' }],
          showCreateTargetSelect: false,
        }}
        detail={detail}
        labels={{
          countSuffix: '个对话',
          createLabel: '新建对话',
          createAriaLabel: '新建对话',
          detailEmptyTitle: '新建一个对话',
          detailEmptyBody: '输入问题后即可开始。',
          collapseList: '收起对话列表',
          expandList: '展开对话列表',
          listAriaLabel: '对话列表',
          searchAriaLabel: '搜索对话',
          searchPlaceholder: '搜索对话',
        }}
      />
      {notice || streamNotice ? <div className="awb-host-notice" role="status">{notice || streamNotice}</div> : null}
      {visibleError ? <div className="awb-host-error" role="alert">{visibleError}</div> : null}
    </main>
  );
}

function userFacingRuntimeError(value) {
  const message = String(value || '').trim();
  if (!message) return '';
  if (/\b529\b|all\s+\d+\s+channels?\s+failed|model-egress.*\b404\b|unexpected status/i.test(message)) {
    return '模型服务暂时不可用，本轮已结束。你可以编辑这条消息后重试，或直接继续提问。';
  }
  return message;
}

function SessionShareControl({ request, sessionId }) {
  const [share, setShare] = useState(null);
  const [query, setQuery] = useState('');
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searching, setSearching] = useState(false);
  const [busyUserId, setBusyUserId] = useState('');
  const [copyState, setCopyState] = useState('');
  const [localError, setLocalError] = useState('');

  useEffect(() => {
    setShare(null);
    setQuery('');
    setUsers([]);
    setLocalError('');
  }, [sessionId]);

  useEffect(() => {
    const search = query.trim();
    if (!search) {
      setUsers([]);
      return undefined;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const body = await request(`users?q=${encodeURIComponent(search)}`, { signal: controller.signal });
        setUsers(body.users || []);
        setLocalError('');
      } catch (error) {
        if (error.name !== 'AbortError') setLocalError(error.message);
      } finally {
        setSearching(false);
      }
    }, 220);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, request]);

  async function loadShare() {
    if (loading) return;
    setLoading(true);
    try {
      const body = await request(`session-shares?sessionId=${encodeURIComponent(sessionId)}`);
      setShare(body.share || null);
      setLocalError('');
    } catch (error) {
      setLocalError(error.message);
    } finally {
      setLoading(false);
    }
  }

  async function shareWithUser(user) {
    setBusyUserId(user.id);
    try {
      const body = await request('session-shares', {
        method: 'POST',
        body: JSON.stringify({ sessionId, principalId: user.id }),
      });
      setShare(body.share);
      setQuery('');
      setUsers([]);
      setLocalError('');
    } catch (error) {
      setLocalError(error.message);
    } finally {
      setBusyUserId('');
    }
  }

  async function removeUser(user) {
    if (!globalThis.confirm?.(`移除对 ${user.name || user.id} 的共享？`)) return;
    setBusyUserId(user.id);
    try {
      const body = await request(`session-shares/${encodeURIComponent(share.id)}/access/${encodeURIComponent(user.id)}`, {
        method: 'DELETE',
      });
      setShare(body.share);
      setLocalError('');
    } catch (error) {
      setLocalError(error.message);
    } finally {
      setBusyUserId('');
    }
  }

  async function copyLink() {
    setCopyState('loading');
    try {
      const body = await request('session-shares', {
        method: 'POST',
        body: JSON.stringify({ sessionId, enableLink: true }),
      });
      setShare(body.share);
      await globalThis.navigator.clipboard.writeText(body.share.linkUrl);
      setCopyState('copied');
      setLocalError('');
      setTimeout(() => setCopyState(''), 1800);
    } catch (error) {
      setCopyState('');
      setLocalError(error.message);
    }
  }

  async function changeLink(action) {
    const label = action === 'reset' ? '重置' : '停用';
    if (!globalThis.confirm?.(`${label}共享链接？`)) return;
    setCopyState('loading');
    try {
      const body = await request(`session-shares/${encodeURIComponent(share.id)}/link${action === 'reset' ? '/reset' : ''}`, {
        method: action === 'reset' ? 'POST' : 'DELETE',
        body: action === 'reset' ? '{}' : undefined,
      });
      setShare(body.share);
      setLocalError('');
    } catch (error) {
      setLocalError(error.message);
    } finally {
      setCopyState('');
    }
  }

  const directUsers = share?.directUsers || [];
  const directIds = new Set(directUsers.map((user) => user.id));
  return (
    <details className="awb-share-control" onToggle={(event) => { if (event.currentTarget.open) loadShare(); }}>
      <summary className="cwu-button">共享</summary>
      <section aria-label="共享对话" className="awb-share-popover">
        <header><strong>共享对话</strong><small>共享后对方只读</small></header>
        <label className="awb-share-search">
          <span aria-hidden="true">⌕</span>
          <input
            aria-label="搜索用户"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索用户"
            type="search"
            value={query}
          />
        </label>
        {query ? <div className="awb-share-results" aria-busy={searching}>
          {searching ? <span>正在搜索…</span> : users.filter((user) => !directIds.has(user.id)).length
            ? users.filter((user) => !directIds.has(user.id)).map((user) => (
              <div key={user.id}>
                <span><strong>{user.name}</strong></span>
                <button
                  aria-label={busyUserId === user.id ? `正在共享给 ${user.name}` : `共享给 ${user.name}`}
                  className="awb-share-person-button"
                  disabled={busyUserId === user.id}
                  onClick={() => shareWithUser(user)}
                  title={busyUserId === user.id ? '共享中…' : `共享给 ${user.name}`}
                  type="button"
                >
                  {busyUserId === user.id ? <span aria-hidden="true">…</span> : <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                    <circle cx="8.5" cy="7.5" r="3" />
                    <path d="M3.5 19c.5-3.5 2.2-5 5-5s4.6 1.5 5 5" />
                    <path d="M17.5 7v6M14.5 10h6" />
                  </svg>}
                </button>
              </div>
            )) : <span>没有匹配的用户</span>}
        </div> : null}
        {directUsers.length ? <div className="awb-share-users">
          {directUsers.map((user) => <div key={user.id}>
            <span><strong>{user.name}</strong></span>
            <button aria-label={`移除 ${user.name}`} disabled={busyUserId === user.id} onClick={() => removeUser(user)} type="button">×</button>
          </div>)}
        </div> : null}
        <div className="awb-share-divider"><span>或者</span></div>
        <div className="awb-share-link">
          <button disabled={copyState === 'loading'} onClick={copyLink} type="button">
            <span aria-hidden="true">🔗</span>
            <span><strong>{copyState === 'copied' ? '已复制' : '复制共享链接'}</strong><small>打开后自动加入对方列表</small></span>
          </button>
          {share?.linkEnabled ? <details className="awb-share-link-menu">
            <summary aria-label="管理共享链接">⋯</summary>
            <div><button onClick={() => changeLink('reset')} type="button">重置链接</button><button onClick={() => changeLink('disable')} type="button">停用链接</button></div>
          </details> : null}
        </div>
        {loading ? <p className="awb-share-state">正在读取共享状态…</p> : null}
        {localError ? <p className="awb-share-error" role="alert">{localError}</p> : null}
      </section>
    </details>
  );
}

function MinimalHostObserverApp() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(initialSessionId);
  const selectedIdRef = useRef(initialSessionId);
  const [session, setSession] = useState(null);
  const [query, setQuery] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [error, setError] = useState('');

  const request = useCallback(async (path) => {
    const response = await fetch(hostUrl(path), {
      headers: {
        accept: 'application/json',
        'x-agent-workbench-token': bootstrap.accessToken || '',
      },
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error?.message || `Request failed (${response.status})`);
    return body;
  }, []);

  const selectSessionId = useCallback((nextValue) => {
    setSelectedId((current) => {
      const next = typeof nextValue === 'function' ? nextValue(current) : nextValue;
      selectedIdRef.current = next;
      return next;
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    const body = await request('api/observer/sessions');
    const next = body.sessions || [];
    setSessions(next);
    selectSessionId((current) => selectMinimalHostSession(
      next.filter((item) => showArchived || !item.archived),
      current,
    ));
    return next;
  }, [request, selectSessionId, showArchived]);

  const refreshSession = useCallback(async (sessionId) => {
    if (!sessionId) return null;
    const body = await request(`api/observer/sessions/${encodeURIComponent(sessionId)}`);
    if (selectedIdRef.current === sessionId) setSession(body.session || null);
    return body.session || null;
  }, [request]);

  useEffect(() => {
    void refreshSessions()
      .then(() => setError(''))
      .catch((nextError) => setError(nextError.message));
    const timer = setInterval(() => {
      void refreshSessions()
        .then(() => setError(''))
        .catch((nextError) => setError(nextError.message));
    }, 5_000);
    return () => clearInterval(timer);
  }, [refreshSessions]);

  useEffect(() => {
    if (!selectedId) {
      setSession(null);
      return undefined;
    }
    let stopped = false;
    let refreshTimer = null;
    let refreshRunning = false;
    let refreshQueued = false;
    const scheduleRefresh = () => {
      refreshQueued = true;
      if (stopped || refreshTimer || refreshRunning) return;
      refreshTimer = setTimeout(async () => {
        refreshTimer = null;
        refreshQueued = false;
        refreshRunning = true;
        try {
          await Promise.all([refreshSessions(), refreshSession(selectedId)]);
          if (!stopped) setError('');
        } catch (nextError) {
          if (!stopped) setError(nextError.message);
        } finally {
          refreshRunning = false;
          if (refreshQueued) scheduleRefresh();
        }
      }, 120);
    };
    scheduleRefresh();
    const controller = new AbortController();
    void maintainMinimalHostEventStream({
      open: ({ afterEventId, signal }) => fetch(hostUrl(
        `api/observer/sessions/${encodeURIComponent(selectedId)}/events?after=${encodeURIComponent(afterEventId)}`,
      ), {
        headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' },
        signal,
      }),
      onEvent: scheduleRefresh,
      signal: controller.signal,
    }).catch((nextError) => {
      if (nextError.name !== 'AbortError') setError(nextError.message);
    });
    const timer = setInterval(scheduleRefresh, 2_000);
    return () => {
      stopped = true;
      controller.abort();
      clearInterval(timer);
      clearTimeout(refreshTimer);
    };
  }, [refreshSession, refreshSessions, selectedId]);

  const archivedCount = useMemo(
    () => sessions.filter((item) => item.archived).length,
    [sessions],
  );
  const visibleSessions = useMemo(
    () => sessions.filter((item) => showArchived || !item.archived),
    [sessions, showArchived],
  );
  const filteredSessions = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return visibleSessions.filter((item) => {
      if (!needle) return true;
      return [item.id, item.ownerId, item.title]
        .some((value) => String(value || '').toLowerCase().includes(needle));
    });
  }, [query, visibleSessions]);
  const turns = useMemo(() => observerTurns(session), [session]);

  return (
    <main className="awb-observer">
      <div className="awb-observer-body">
        <aside className="awb-observer-sidebar">
          <div className="awb-observer-filters">
            <input
              aria-label="搜索全部 Session"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="用户、标题或 Session ID"
              type="search"
              value={query}
            />
            <label className="awb-observer-archive-toggle">
              <input
                checked={showArchived}
                onChange={(event) => setShowArchived(event.target.checked)}
                type="checkbox"
              />
              <span>显示已归档</span>
              <small>{visibleSessions.length} 个{archivedCount ? ` · ${archivedCount} 已归档` : ''}</small>
            </label>
          </div>
          <div className="awb-observer-session-list">
            {filteredSessions.map((item) => {
              const stale = ['running', 'waiting'].includes(item.status)
                && Date.now() - Date.parse(item.updatedAt) > 5 * 60_000;
              return (
                <button
                  className={item.id === selectedId ? 'is-selected' : ''}
                  key={item.id}
                  onClick={() => selectSessionId(item.id)}
                  type="button"
                >
                  <span><i data-status={stale ? 'stale' : item.status} />{item.ownerId || '无 owner'}</span>
                  <strong>{item.title || '新对话'}</strong>
                  <small>{observerStatusLabel(item.status, stale)} · {relativeTime(item.updatedAt)}</small>
                </button>
              );
            })}
            {!filteredSessions.length ? <p>没有匹配的 Session。</p> : null}
          </div>
        </aside>
        <section className="awb-observer-detail">
          {session ? (
            <>
              <header>
                <div>
                  <h2>{session.title}</h2>
                  <span>Owner {session.ownerId || '—'} · {session.id}</span>
                </div>
                {session.status !== 'idle'
                  ? <em data-status={session.status}>{observerStatusLabel(session.status)}</em>
                  : null}
              </header>
              <div className="awb-observer-process">
                {turns.map((turn, turnIndex) => {
                  const visibleSteps = observerVisibleSteps(turn.technicalItems);
                  const omittedSteps = turn.technicalItems.length - visibleSteps.length;
                  return (
                    <section className="awb-observer-turn" key={turn.id}>
                      <header><strong>第 {turnIndex + 1} 轮</strong><span>{formatTime(turn.startedAt)}</span></header>
                      {turn.userMessages.map((message) => (
                        <article data-kind="user" key={message.id}>
                          <small>用户问题</small><p>{message.content || '（无文本内容）'}</p>
                        </article>
                      ))}
                      {turn.commentaryMessages.map((message) => (
                        <article data-kind="commentary" key={message.id}>
                          <small>模型过程</small><p>{message.content || '（暂无外显过程）'}</p>
                        </article>
                      ))}
                      {turn.technicalItems.length ? (
                        <section className="awb-observer-steps">
                          <h3>执行步骤 <small>{visibleSteps.length}/{turn.technicalItems.length} 个有详情</small></h3>
                          {omittedSteps ? <p className="awb-observer-legacy-note">{omittedSteps} 个旧步骤没有保存名称或详情，已省略。</p> : null}
                          <ol>
                            {visibleSteps.map((item, stepIndex) => (
                              <li key={item.id}>
                                <details open={['running', 'inProgress', 'failed'].includes(item.status)}>
                                  <summary>
                                    <span><b>{stepIndex + 1}</b>{observerStepTitle(item)}</span>
                                    <em>{observerStepStatus(item.status)}{itemDuration(item) ? ` · ${itemDuration(item)}` : ''}</em>
                                  </summary>
                                  {item.detail ? <pre>{item.detail}</pre> : <p>旧记录未保存该步骤的输入或错误详情。</p>}
                                </details>
                              </li>
                            ))}
                          </ol>
                        </section>
                      ) : null}
                      {turn.answerMessages.map((message) => (
                        <article data-kind="answer" key={message.id}>
                          <small>最终回答</small><p>{message.content || '（暂无回答）'}</p>
                        </article>
                      ))}
                    </section>
                  );
                })}
                {!turns.length ? <p className="awb-observer-empty">这个 Session 暂无过程记录。</p> : null}
              </div>
            </>
          ) : <div className="awb-observer-placeholder">选择一个 Session 查看实时过程。</div>}
        </section>
      </div>
      {error ? <div className="awb-host-error" role="alert">{error}</div> : null}
    </main>
  );
}

const observerMode = new URLSearchParams(globalThis.location?.search || '').get('view') === 'observer';
createRoot(document.getElementById('root')).render(observerMode ? <MinimalHostObserverApp /> : <MinimalHostApp />);

function observerStatusLabel(status, stale = false) {
  if (stale) return '疑似停滞';
  return ({ running: '运行中', waiting: '等待输入', error: '异常', idle: '空闲' })[status] || String(status || '未知');
}

function observerTurns(session) {
  if (!session) return [];
  const turns = [];
  const byId = new Map();
  const ensureTurn = (turnId, fallbackId) => {
    const id = String(turnId || fallbackId);
    if (!byId.has(id)) {
      const turn = { id, messages: [], technicalItems: [], startedAt: null };
      byId.set(id, turn);
      turns.push(turn);
    }
    return byId.get(id);
  };
  for (const message of session.messages || []) {
    const turn = ensureTurn(message.turnId, `message-${message.id}`);
    turn.messages.push(message);
    turn.startedAt ||= message.createdAt || null;
  }
  for (const item of session.technicalItems || []) {
    const turn = ensureTurn(item.turnId, `step-${item.id}`);
    turn.technicalItems.push(item);
    turn.startedAt ||= item.startedAt || item.updatedAt || null;
  }
  return turns.map((turn) => ({
    ...turn,
    userMessages: turn.messages.filter((message) => message.role === 'user'),
    commentaryMessages: turn.messages.filter((message) => message.role === 'assistant' && message.phase === 'commentary'),
    answerMessages: turn.messages.filter((message) => message.role === 'assistant' && message.phase !== 'commentary'),
  }));
}

function observerVisibleSteps(items = []) {
  return items.filter((item) => {
    const detail = String(item.detail || '').trim();
    const named = String(item.title || '').includes(' · ');
    const notableStatus = ['running', 'inProgress', 'failed'].includes(item.status);
    return detail || named || notableStatus || Number.isFinite(Number(item.durationMs));
  });
}

function observerStepTitle(item) {
  const title = String(item.title || 'Runtime item');
  const separator = title.indexOf(' · ');
  const prefix = separator >= 0 ? title.slice(0, separator) : title;
  const subject = separator >= 0 ? title.slice(separator + 3) : '';
  const localized = ({
    Reasoning: '分析摘要',
    Command: '执行命令',
    'File change': '修改文件',
    'Tool call': '调用工具',
    'Web search': '网页搜索',
  })[prefix] || prefix;
  return subject ? `${localized} · ${subject}` : localized;
}

function observerStepStatus(status) {
  return ({ inProgress: '执行中', running: '执行中', completed: '完成', failed: '失败', cancelled: '已取消', canceled: '已取消' })[status]
    || String(status || '未知');
}

function formatTime(value) {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    ? new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(timestamp)
    : '—';
}

function relativeTime(value) {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return '未知时间';
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function itemDuration(item) {
  const reportedMilliseconds = Number(item?.durationMs);
  if (Number.isFinite(reportedMilliseconds) && reportedMilliseconds >= 0) {
    return formatDuration(reportedMilliseconds);
  }
  const startedAt = Date.parse(item?.startedAt);
  const endedAt = Date.parse(item?.completedAt || item?.updatedAt);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || endedAt < startedAt) return '';
  return formatDuration(endedAt - startedAt);
}

function formatDuration(milliseconds) {
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  if (milliseconds < 60_000) return `${(milliseconds / 1_000).toFixed(1)}s`;
  return `${Math.floor(milliseconds / 60_000)}m ${Math.round((milliseconds % 60_000) / 1_000)}s`;
}

function messageActionPresentation(session) {
  const latestUserMessage = [...(session.messages || [])].reverse().find((message) => message.role === 'user');
  const branchable = session.access?.kind !== 'shared';
  return {
    ...session,
    messages: (session.messages || []).map((message) => ({
      ...message,
      ...sessionMessageBranchEligibility({
        session,
        message,
        isLatestUserMessage: message === latestUserMessage,
        features: {
          messageEdit: messageEditEnabled && branchable,
          messageFork: messageForkEnabled && branchable,
        },
      }),
    })),
  };
}

function mergeSessionSummaries(current, incoming) {
  const merged = new Map((current || []).map((session) => [
    session.id || session.sessionId,
    session,
  ]));
  for (const candidate of incoming || []) {
    const presented = minimalHostSessionPresentation(candidate);
    merged.set(presented.id || presented.sessionId, presented);
  }
  return [...merged.values()].sort(
    (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
  );
}

function mergeById(current = [], incoming = []) {
  const merged = new Map();
  for (const item of current || []) merged.set(item.id, item);
  for (const item of incoming || []) merged.set(item.id, item);
  return [...merged.values()];
}

function mergeTurnMetadata(current = [], incoming = []) {
  const merged = new Map();
  for (const turn of current || []) merged.set(turn.turnKey || turn.turnId, turn);
  for (const turn of incoming || []) merged.set(turn.turnKey || turn.turnId, turn);
  return [...merged.values()].sort((left, right) => (
    (Number(left.ordinal) || Number.MAX_SAFE_INTEGER) - (Number(right.ordinal) || Number.MAX_SAFE_INTEGER)
  ));
}

function mergeConversationRefresh(current, latest) {
  const retainEarlierPaging = Boolean(current.turnsCursor)
    && Number(current.loadedTurnCount) > Number(latest.loadedTurnCount);
  const turnMetadata = mergeTurnMetadata(current.turnMetadata, latest.turnMetadata);
  return {
    ...current,
    ...latest,
    messages: mergeById(current.messages, latest.messages),
    technicalItems: mergeById(current.technicalItems, latest.technicalItems),
    turnMetadata,
    technicalDetailsAvailable: [...new Set([
      ...(current.technicalDetailsAvailable || []),
      ...(latest.technicalDetailsAvailable || []),
    ])],
    hasEarlierTurns: retainEarlierPaging ? current.hasEarlierTurns : latest.hasEarlierTurns,
    turnsCursor: retainEarlierPaging ? current.turnsCursor : latest.turnsCursor,
    loadedTurnCount: turnMetadata.length,
    historyLoading: false,
  };
}

function mergeEarlierConversation(current, earlier) {
  const turnMetadata = mergeTurnMetadata(earlier.turnMetadata, current.turnMetadata);
  return {
    ...current,
    messages: mergeById(earlier.messages, current.messages),
    technicalItems: mergeById(earlier.technicalItems, current.technicalItems),
    turnMetadata,
    technicalDetailsAvailable: [...new Set([
      ...(earlier.technicalDetailsAvailable || []),
      ...(current.technicalDetailsAvailable || []),
    ])],
    hasEarlierTurns: earlier.hasEarlierTurns,
    turnsCursor: earlier.turnsCursor,
    loadedTurnCount: turnMetadata.length,
    turnCount: Math.max(Number(current.turnCount) || 0, Number(earlier.turnCount) || 0),
    historyLoading: false,
  };
}

function abortError() {
  if (typeof DOMException === 'function') return new DOMException('The operation was aborted.', 'AbortError');
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

function featureEnabled(name) {
  return bootstrap.features?.[name] !== false;
}

async function uploadSessionAttachments(sessionId, files, { onProgress } = {}) {
  const uploaded = [];
  for (const file of files || []) {
    const data = await fileAsDataUrl(file, (progress) => onProgress?.(progress * 0.35));
    const result = await uploadAttachmentRequest(sessionId, {
      attachment: { name: file.name, type: file.type, size: file.size, data },
    }, (progress) => onProgress?.(35 + progress * 0.65));
    if (result.attachment) uploaded.push(result.attachment);
  }
  return uploaded;
}

function fileAsDataUrl(file, onProgress = null) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.((event.loaded / event.total) * 100);
    });
    reader.addEventListener('load', () => {
      onProgress?.(100);
      resolve(String(reader.result || ''));
    }, { once: true });
    reader.addEventListener('error', () => reject(new Error('附件读取失败')), { once: true });
    reader.readAsDataURL(file);
  });
}

function uploadAttachmentRequest(sessionId, payload, onProgress = null) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', hostUrl(`api/sessions/${encodeURIComponent(sessionId)}/attachments`));
    request.setRequestHeader('content-type', 'application/json');
    if (bootstrap.accessToken) request.setRequestHeader('x-agent-workbench-token', bootstrap.accessToken);
    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) onProgress?.((event.loaded / event.total) * 100);
    });
    request.addEventListener('load', () => {
      const body = (() => {
        try { return JSON.parse(request.responseText || '{}'); } catch { return {}; }
      })();
      if (request.status < 200 || request.status >= 300) {
        reject(new Error(body.error?.message || `附件上传失败 (${request.status})`));
        return;
      }
      onProgress?.(100);
      resolve(body);
    }, { once: true });
    request.addEventListener('error', () => reject(new Error('附件上传网络中断')), { once: true });
    request.send(JSON.stringify(payload));
  });
}
