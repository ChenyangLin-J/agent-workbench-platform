import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { SessionBrowser } from '../ui/index.jsx';
import { sessionMessageBranchEligibility } from '../features/session-branch.js';
import { maintainMinimalHostEventStream } from './host-event-stream.js';
import { minimalHostSessionPresentation, selectMinimalHostSession } from './host-presentation.js';
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
const initialSessionId = new URLSearchParams(globalThis.location?.search || '').get('session');
const RUNNING_SESSION_POLL_MS = 2_000;
const SHARED_SESSION_POLL_MS = 5_000;

function hostUrl(path) {
  return resolveMinimalHostUrl(path, { baseUrl: hostBaseUrl });
}

function MinimalHostApp() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState(initialSessionId);
  const [session, setSession] = useState(null);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [continuing, setContinuing] = useState(false);
  const continuationKey = useRef(null);
  const openedShares = useRef(new Set());
  const refreshTimer = useRef(null);
  const refreshRunning = useRef(false);
  const refreshQueued = useRef(false);

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
    const merged = new Map();
    let sharedOffset = null;
    let sharedPagesComplete = false;
    for (let page = 0; page < 100; page += 1) {
      const body = await request(sharedOffset == null
        ? 'api/sessions'
        : `api/sessions?sharedOffset=${encodeURIComponent(sharedOffset)}`);
      for (const candidate of body.sessions || []) {
        const presented = minimalHostSessionPresentation(candidate);
        merged.set(presented.id || presented.sessionId, presented);
      }
      if (body.sharedNextOffset == null) {
        sharedPagesComplete = true;
        break;
      }
      if (body.sharedNextOffset === sharedOffset) throw new Error('共享对话分页未前进。');
      sharedOffset = body.sharedNextOffset;
    }
    if (!sharedPagesComplete) throw new Error('共享对话数量超出客户端分页上限。');
    const nextSessions = [...merged.values()].sort(
      (left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt),
    );
    setSessions(nextSessions);
    setSelectedId((current) => selectMinimalHostSession(nextSessions, current));
    return nextSessions;
  }, [request]);

  const refreshSession = useCallback(async (sessionId = selectedId) => {
    if (!sessionId) return null;
    const body = await request(`api/sessions/${encodeURIComponent(sessionId)}`);
    const nextSession = messageActionPresentation(minimalHostSessionPresentation(body.session));
    setSession(nextSession);
    return nextSession;
  }, [request, selectedId]);

  const scheduleRefresh = useCallback(() => {
    refreshQueued.current = true;
    if (refreshTimer.current || refreshRunning.current) return;
    refreshTimer.current = setTimeout(async () => {
      refreshTimer.current = null;
      refreshQueued.current = false;
      refreshRunning.current = true;
      try {
        await refreshSessions();
        await refreshSession();
        setError('');
      } catch (nextError) {
        setError(nextError.message);
      } finally {
        refreshRunning.current = false;
        if (refreshQueued.current) scheduleRefresh();
      }
    }, 180);
  }, [refreshSession, refreshSessions]);

  const selectedSessionLoaded = session?.sessionId === selectedId;
  const selectedShared = selectedSessionLoaded
    ? session?.access?.kind === 'shared'
    : sessions.find((candidate) => candidate.id === selectedId)?.access?.kind === 'shared';

  useEffect(() => {
    refreshSessions().catch((nextError) => setError(nextError.message));
    return () => {
      clearTimeout(refreshTimer.current);
      refreshTimer.current = null;
      refreshQueued.current = false;
    };
  }, [refreshSessions]);

  useEffect(() => {
    if (!selectedId) {
      setSession(null);
      return undefined;
    }
    refreshSession(selectedId).catch((nextError) => setError(nextError.message));
    if (!selectedSessionLoaded) return undefined;
    if (selectedShared) {
      const timer = setInterval(scheduleRefresh, SHARED_SESSION_POLL_MS);
      return () => clearInterval(timer);
    }
    const controller = new AbortController();
    void maintainMinimalHostEventStream({
      open: ({ afterEventId, signal }) => fetch(hostUrl(
        `api/sessions/${encodeURIComponent(selectedId)}/events?after=${encodeURIComponent(afterEventId)}`,
      ), {
        headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' },
        signal,
      }),
      onEvent: scheduleRefresh,
      signal: controller.signal,
    }).catch((nextError) => {
      if (nextError.name !== 'AbortError') setError(nextError.message);
    });
    return () => controller.abort();
  }, [refreshSession, scheduleRefresh, selectedId, selectedSessionLoaded, selectedShared]);

  const sessionRunning = session?.status === 'running' || session?.status === 'waiting';
  useEffect(() => {
    if (!selectedId || !sessionRunning) return undefined;
    scheduleRefresh();
    const timer = setInterval(scheduleRefresh, RUNNING_SESSION_POLL_MS);
    return () => clearInterval(timer);
  }, [scheduleRefresh, selectedId, sessionRunning]);

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
    try {
      const body = await request('api/sessions', { method: 'POST', body: JSON.stringify({}) });
      await refreshSessions();
      setSelectedId(body.session.sessionId);
    } catch (nextError) {
      setError(nextError.message);
    }
  }

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
      setSession(nextSession);
      await refreshSessions();
      setSelectedId(nextSession.sessionId);
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
    try {
      await request(`api/sessions/${encodeURIComponent(selectedId)}/turns`, {
        method: 'POST',
        body: JSON.stringify({ prompt, mode, attachments }),
      });
      setSession((current) => current ? { ...current, status: 'running', statusLabel: '正在处理' } : current);
      scheduleRefresh();
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
    if (!selectedId || !attachment?.id) return;
    const response = await fetch(hostUrl(
      `api/sessions/${encodeURIComponent(selectedId)}/attachments/${encodeURIComponent(attachment.id)}/content`,
    ), {
      headers: { 'x-agent-workbench-token': bootstrap.accessToken || '' },
    });
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw new Error(body.error?.message || `附件读取失败 (${response.status})`);
    }
    const objectUrl = URL.createObjectURL(await response.blob());
    globalThis.open(objectUrl, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
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
        body: JSON.stringify({ replaceTurnId: turnId, prompt, intent }),
      });
      const nextSession = messageActionPresentation(minimalHostSessionPresentation(body.session));
      setSession(nextSession);
      await refreshSessions();
      setSelectedId(nextSession.sessionId);
      scheduleRefresh();
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
    scheduleRefresh();
  }

  const sharedReadOnly = session?.access?.kind === 'shared';
  const sessionMutable = !session?.runtimeContinuationRequired && !sharedReadOnly;
  const detail = useMemo(() => session ? {
    session,
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
      onInterrupt: sessionMutable && session.status === 'running' ? interrupt : null,
      onEditMessage: messageEditEnabled && sessionMutable ? (input) => branchMessage(input, 'edit') : null,
      onForkMessage: messageForkEnabled && sessionMutable ? (input) => branchMessage(input, 'fork') : null,
      onDeleteQueuedTurn: queuedTurnsEnabled && sessionMutable ? deleteQueuedTurn : null,
      onRespondToRequest: sessionMutable ? respondToRequest : null,
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
          共享对话为只读，如需继续请点击右上角“继续聊”
        </div>
      ) : null,
    },
  } : null, [session, selectedId, sessionMutable, sharedReadOnly, continuing, productRequest]);

  const runtimeError = session?.status === 'error' ? session.runtimeBinding?.lastError : '';
  const visibleError = error || runtimeError;

  return (
    <main className="awb-minimal-host">
      <SessionBrowser
        actions={{
          onCreate: createSession,
          onSelect: (nextSession) => setSelectedId(nextSession.id),
          onToggleList: setListCollapsed,
        }}
        browser={{
          sessions,
          selectedSessionId: selectedId,
          listCollapsed,
          groupMode: sessionSharing ? 'context' : 'time',
          groupOptions: [{ id: sessionSharing ? 'context' : 'time', label: sessionSharing ? '对话' : '最近' }],
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
      {notice ? <div className="awb-host-notice" role="status">{notice}</div> : null}
      {visibleError ? <div className="awb-host-error" role="alert">{visibleError}</div> : null}
    </main>
  );
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
                <span><strong>{user.name}</strong><small>{user.email || ''}</small></span>
                <button disabled={busyUserId === user.id} onClick={() => shareWithUser(user)} type="button">
                  {busyUserId === user.id ? '共享中…' : '共享'}
                </button>
              </div>
            )) : <span>没有匹配的用户</span>}
        </div> : null}
        {directUsers.length ? <div className="awb-share-users">
          {directUsers.map((user) => <div key={user.id}>
            <span><strong>{user.name}</strong><small>可查看</small></span>
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

createRoot(document.getElementById('root')).render(<MinimalHostApp />);

function messageActionPresentation(session) {
  const latestUserMessage = [...(session.messages || [])].reverse().find((message) => message.role === 'user');
  const mutable = !session.runtimeContinuationRequired && session.access?.kind !== 'shared';
  return {
    ...session,
    messages: (session.messages || []).map((message) => ({
      ...message,
      ...sessionMessageBranchEligibility({
        session,
        message,
        isLatestUserMessage: message === latestUserMessage,
        features: {
          messageEdit: messageEditEnabled && mutable,
          messageFork: messageForkEnabled && mutable,
        },
      }),
    })),
  };
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
