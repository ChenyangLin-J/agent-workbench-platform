import React, { useEffect, useMemo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import '../browser/realtime-controller.js';
import '../browser/session-status-element.js';
import '../browser/session-ui-elements.js';
import '../browser/subagent-elements.js';

import {
  clipboardAttachmentFiles,
  groupSessionSummaries,
  extractInlineVisualizations,
  extractRemarkDirectives,
  normalizeSessionBrowserViewModel,
  normalizeSessionViewModel,
  normalizeSideChatPanelViewModel,
  renderFileCitationsAsMarkdown,
  sessionStatusTone,
} from './model.js';
import { sessionComposerPresentation } from '../session.js';
import { normalizeSessionFeatures } from '../capabilities.js';
import { normalizeAttachmentPolicy } from '../attachments.js';
import { useSessionUserInput } from '../ui-hooks.js';

export { useSessionUserInput } from '../ui-hooks.js';

const SESSION_COMPOSER_TEXT_LIMIT = 12000;

export function SideChatPanel({
  panel,
  actions = {},
  labels = {},
}) {
  const view = useMemo(() => normalizeSideChatPanelViewModel(panel), [panel]);
  const selected = view.selected;
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const streamRef = useRef(null);
  const readOnly = Boolean(selected && !selected.resumable);
  const running = selected?.status === 'running';
  const selectedModel = selected?.model || view.models.find((model) => model.isDefault)?.id || view.models[0]?.id || '';
  const model = view.models.find((candidate) => candidate.id === selectedModel) || null;
  const reasoningEfforts = model?.reasoningEfforts?.length ? model.reasoningEfforts : ['low', 'medium', 'high', 'xhigh'];
  const selectedEffort = selected?.reasoningEffort || model?.defaultReasoningEffort || 'medium';

  useEffect(() => {
    setDraft('');
    setError('');
  }, [view.selectedId]);

  useEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [selected?.status, selected?.transcript]);

  async function run(action) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await action?.();
    } catch (actionError) {
      const message = actionError?.message || labels.error || 'Side Chat 操作失败';
      setError(message);
      actions.onError?.(actionError);
    } finally {
      setBusy(false);
    }
  }

  async function submit(event) {
    event.preventDefault();
    const prompt = draft.trim();
    if (!prompt || busy || running || readOnly || !actions.onSubmit) return;
    await run(async () => {
      await actions.onSubmit({ sideChatId: selected.id, prompt });
      setDraft('');
    });
  }

  async function updateModel(modelId) {
    const nextModel = view.models.find((candidate) => candidate.id === modelId);
    await run(() => actions.onUpdate?.({
      sideChatId: selected.id,
      model: modelId,
      reasoningEffort: nextModel?.defaultReasoningEffort || 'medium',
    }));
  }

  return (
    <section className="cwu-side-chat" aria-label={labels.ariaLabel || 'Side Chats'}>
      <div className="cwu-side-chat-tabs" role="tablist" aria-label={labels.tabsAriaLabel || 'Side Chats'}>
        {view.sideChats.map((sideChat) => (
          <div className="cwu-side-chat-tab-wrap" key={sideChat.id}>
            <button
              aria-selected={sideChat.id === view.selectedId}
              className={sideChat.status === 'expired' ? 'is-expired' : ''}
              disabled={busy}
              onClick={() => actions.onSelect?.(sideChat.id)}
              role="tab"
              type="button"
            >{sideChat.title}</button>
            {actions.onDelete ? (
              <button
                aria-label={`${labels.delete || '永久删除'} ${sideChat.title}`}
                className="cwu-side-chat-delete"
                disabled={busy || sideChat.status === 'running'}
                onClick={() => run(() => actions.onDelete(sideChat.id))}
                type="button"
              >{labels.delete || '删除'}</button>
            ) : null}
          </div>
        ))}
        <button
          aria-label={labels.new || '新建 Side Chat'}
          className="cwu-side-chat-add"
          disabled={busy}
          onClick={() => actions.onSelect?.(null)}
          type="button"
        >＋</button>
      </div>

      {!selected ? (
        <div className="cwu-side-chat-empty">
          <strong>{labels.emptyTitle || '新建 Side Chat'}</strong>
          <p>{labels.emptyBody || '基于主 Session 当前上下文创建独立对话；回答会保留，直到你明确删除。'}</p>
          <button className="cwu-send" disabled={busy || !actions.onCreate} onClick={() => run(actions.onCreate)} type="button">
            {busy ? (labels.creating || '创建中…') : (labels.create || '创建 Side Chat')}
          </button>
        </div>
      ) : (
        <>
          <div className="cwu-side-chat-config">
            <label>
              <span>{labels.model || '模型'}</span>
              <select disabled={busy || running || readOnly || !actions.onUpdate} onChange={(event) => updateModel(event.target.value)} value={selectedModel}>
                {view.models.length ? view.models.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>{candidate.label}</option>
                )) : <option value={selectedModel}>{selectedModel || labels.defaultModel || '默认模型'}</option>}
              </select>
            </label>
            <label>
              <span>{labels.reasoning || '推理'}</span>
              <select
                disabled={busy || running || readOnly || !actions.onUpdate}
                onChange={(event) => run(() => actions.onUpdate({
                  sideChatId: selected.id,
                  model: selectedModel,
                  reasoningEffort: event.target.value,
                }))}
                value={selectedEffort}
              >
                {reasoningEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabel(effort)}</option>)}
              </select>
            </label>
            <span>{running ? (labels.running || '回答中') : readOnly ? (labels.retained || '已保留记录') : (labels.independent || '独立 Fork')}</span>
          </div>

          <div className="cwu-side-chat-stream" ref={streamRef}>
            <p>{labels.created || '创建于'} {defaultFormatTime(selected.createdAt)} · {labels.detached || '与主 Session 不再同步'}</p>
            {selected.selectedText ? <blockquote>{selected.selectedText}</blockquote> : null}
            {selected.transcript.length ? selected.transcript.map((message) => (
              <article className={`cwu-side-chat-message is-${message.role}`} key={message.id}>{message.content}</article>
            )) : <div className="cwu-side-chat-placeholder">{labels.promptHint || '输入一个不会写回主 Session 的问题。'}</div>}
            {readOnly ? <div className="cwu-side-chat-placeholder">{labels.readOnly || '记录已保留；Runtime 失效后不能继续追问，请新建 Side Chat。'}</div> : null}
          </div>

          {error ? <div className="cwu-side-chat-error" role="alert">{error}</div> : null}
          {!readOnly ? (
            <form className="cwu-side-chat-composer" onSubmit={submit}>
              <textarea
                aria-label={labels.composerAriaLabel || 'Side Chat 问题'}
                disabled={busy || running}
                maxLength={12000}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={labels.composerPlaceholder || '在临时上下文中追问…'}
                rows={3}
                value={draft}
              />
              <div>
                <span>{selectedModel || labels.defaultModel || '默认模型'} · {selectedEffort}</span>
                <button className="cwu-send" disabled={!draft.trim() || busy || running || !actions.onSubmit} type="submit">
                  {running ? (labels.running || '回答中') : busy ? (labels.sending || '发送中…') : (labels.send || '发送')}
                </button>
              </div>
            </form>
          ) : null}
        </>
      )}
      {error && !selected ? <div className="cwu-side-chat-error" role="alert">{error}</div> : null}
    </section>
  );
}

export function SessionBrowser({
  browser,
  detail = null,
  actions = {},
  labels = {},
}) {
  const view = useMemo(() => normalizeSessionBrowserViewModel(browser), [browser]);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [archivingIds, setArchivingIds] = useState(() => new Set());
  const [undoArchive, setUndoArchive] = useState(null);
  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return view.sessions;
    return view.sessions.filter((session) => (
      `${session.title} ${session.contextLabel}`.toLocaleLowerCase().includes(query)
    ));
  }, [searchQuery, view.sessions]);
  const groups = useMemo(
    () => groupSessionSummaries(visibleSessions, view.groupMode),
    [view.groupMode, visibleSessions],
  );
  const [createTargetId, setCreateTargetId] = useState(view.createTargets[0]?.id || '');
  const [creating, setCreating] = useState(false);
  const [expandedGroupIds, setExpandedGroupIds] = useState(() => new Set());
  const [narrowListOpen, setNarrowListOpen] = useState(false);
  const loadMoreRef = useRef(null);
  const loadMoreLockedRef = useRef(false);
  const [isNarrow, setIsNarrow] = useState(() => (
    typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 640px)').matches
  ));

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return undefined;
    const media = window.matchMedia('(max-width: 640px)');
    const syncResponsiveList = () => {
      setIsNarrow(media.matches);
      if (!media.matches) setNarrowListOpen(false);
    };
    syncResponsiveList();
    media.addEventListener('change', syncResponsiveList);
    window.addEventListener('resize', syncResponsiveList);
    return () => {
      media.removeEventListener('change', syncResponsiveList);
      window.removeEventListener('resize', syncResponsiveList);
    };
  }, []);

  useEffect(() => {
    if (isNarrow) setNarrowListOpen(false);
  }, [detail?.session?.sessionId, isNarrow]);

  const listCollapsed = isNarrow && detail ? !narrowListOpen : view.listCollapsed;

  function toggleSessionList() {
    if (isNarrow && detail) {
      setNarrowListOpen((current) => !current);
      return;
    }
    const nextCollapsed = !view.listCollapsed;
    actions.onToggleList?.(nextCollapsed);
  }

  useEffect(() => {
    if (view.createTargets.some((target) => target.id === createTargetId)) return;
    setCreateTargetId(view.createTargets[0]?.id || '');
  }, [createTargetId, view.createTargets]);

  useEffect(() => {
    if (!undoArchive) return undefined;
    const timeout = setTimeout(() => setUndoArchive(null), 8000);
    return () => clearTimeout(timeout);
  }, [undoArchive]);

  useEffect(() => {
    if (!view.loadingMore) loadMoreLockedRef.current = false;
  }, [view.loadingMore, view.sessions.length]);

  useEffect(() => {
    const target = loadMoreRef.current;
    if (!target || !view.hasMore || view.loadingMore || !actions.onLoadMore) return undefined;
    if (typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) requestMore();
    }, { root: target.closest('.cwu-browser-groups'), rootMargin: '180px 0px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [actions.onLoadMore, view.hasMore, view.loadingMore, view.sessions.length]);

  async function createSession(targetId = createTargetId) {
    if (!targetId || creating || !actions.onCreate) return;
    setCreating(true);
    try {
      await actions.onCreate(targetId);
    } finally {
      setCreating(false);
    }
  }

  function toggleGroup(groupId) {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  async function setArchived(session, archived) {
    if (!actions.onArchive || archivingIds.has(session.id)) return;
    setArchivingIds((current) => new Set(current).add(session.id));
    try {
      await actions.onArchive(session, archived);
      setUndoArchive(archived ? session : null);
    } catch {
      setUndoArchive(null);
    } finally {
      setArchivingIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  }

  async function requestMore() {
    if (!view.hasMore || view.loadingMore || loadMoreLockedRef.current || !actions.onLoadMore) return;
    loadMoreLockedRef.current = true;
    try {
      await actions.onLoadMore();
    } finally {
      loadMoreLockedRef.current = false;
    }
  }

  const formatTime = labels.formatTime || defaultFormatTime;
  return (
    <div className={`cwu-browser ${listCollapsed ? 'is-list-collapsed' : ''}`}>
      <aside className="cwu-browser-list" aria-hidden={listCollapsed} aria-label={labels.listAriaLabel || 'Session 列表'}>
        <header className="cwu-browser-summary">
          <span>{view.loading && !view.sessions.length
            ? (labels.loading || '正在读取 Sessions…')
            : `${view.sessions.length}${view.hasMore ? '+' : ''} ${labels.countSuffix || '个 Session'}`}</span>
          {view.createTargets.length && actions.onCreate ? (
            <div className="cwu-browser-create">
              <select
                aria-label={labels.createTargetAriaLabel || '选择新 Session 的归属'}
                disabled={creating}
                onChange={(event) => setCreateTargetId(event.target.value)}
                value={createTargetId}
              >
                {view.createTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select>
              <button
                aria-label={labels.createAriaLabel || '新建 Session'}
                disabled={!createTargetId || creating}
                onClick={() => createSession()}
                title={labels.createLabel || '新建 Session'}
                type="button"
              >＋</button>
            </div>
          ) : null}
        </header>

        <div className="cwu-browser-toolbar">
          <div role="group" aria-label={labels.groupAriaLabel || 'Session 展示方式'}>
            <button
              className={view.groupMode === 'context' ? 'is-active' : ''}
              onClick={() => actions.onGroupModeChange?.('context')}
              type="button"
            >{labels.contextGroup || '按归属'}</button>
            <button
              className={view.groupMode === 'time' ? 'is-active' : ''}
              onClick={() => actions.onGroupModeChange?.('time')}
              type="button"
            >{labels.timeGroup || '按时间'}</button>
          </div>
          <div className="cwu-browser-toolbar-actions">
            <button
              aria-expanded={searchOpen}
              aria-label={labels.searchAriaLabel || '搜索 Sessions'}
              className={searchOpen ? 'is-active' : ''}
              onClick={() => setSearchOpen((current) => !current)}
              title={labels.searchAriaLabel || '搜索 Sessions'}
              type="button"
            >⌕</button>
            {actions.onRefresh ? <button onClick={actions.onRefresh} type="button">{labels.refresh || '刷新'}</button> : null}
          </div>
        </div>

        {searchOpen || searchQuery ? (
          <label className="cwu-browser-search">
            <span aria-hidden="true">⌕</span>
            <input
              aria-label={labels.searchAriaLabel || '搜索 Sessions'}
              autoFocus
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={labels.searchPlaceholder || '搜索 Session 或归属'}
              type="search"
              value={searchQuery}
            />
            <button
              aria-label={searchQuery ? '清空搜索' : '关闭搜索'}
              onClick={() => { setSearchQuery(''); setSearchOpen(false); }}
              type="button"
            >×</button>
          </label>
        ) : null}

        <div aria-busy={view.loading || view.loadingMore} className="cwu-browser-groups">
          {!view.loading && !groups.length ? (
            <div className="cwu-browser-list-empty">{searchQuery ? (labels.searchEmpty || '没有匹配的 Session。') : (labels.listEmpty || '还没有 Session，可从上方新建。')}</div>
          ) : groups.map((group) => {
            const projectGroup = view.groupMode === 'context';
            const expanded = projectGroup && expandedGroupIds.has(group.id);
            const visibleSessions = projectGroup
              ? group.sessions.slice(0, expanded ? group.sessions.length : 3)
              : group.sessions;
            const hiddenCount = group.sessions.length - visibleSessions.length;
            return (
            <section className={`cwu-browser-group ${expanded ? 'is-expanded' : 'is-collapsed'}`} key={group.id}>
              <div className="cwu-browser-group-heading">
                {projectGroup ? (
                  <button
                    aria-expanded={expanded}
                    className="cwu-browser-group-toggle"
                    onClick={() => toggleGroup(group.id)}
                    title={expanded ? '折叠项目' : '展开项目'}
                    type="button"
                  >
                    <span title={group.label}>{group.label}</span>
                    <i aria-hidden="true">{expanded ? '⌃' : '⌄'}</i>
                  </button>
                ) : <span title={group.label}>{group.label}</span>}
                <div>
                  <small>{group.sessions.length}</small>
                  {view.groupMode === 'context' && actions.onCreate
                    && view.createTargets.some((target) => target.id === group.id) ? (
                    <button
                      aria-label={`${labels.createInContext || '在此归属下新建 Session'}：${group.label}`}
                      className="cwu-browser-group-create"
                      disabled={creating}
                      onClick={() => createSession(group.id)}
                      title={labels.createLabel || '新建 Session'}
                      type="button"
                    >＋</button>
                  ) : null}
                </div>
              </div>
              {visibleSessions.map((session) => {
                const unread = session.status === 'unread';
                return (
                <div
                  className={`cwu-browser-row ${session.id === view.selectedSessionId ? 'is-active' : ''} ${unread ? 'is-unread' : ''}`}
                  key={session.id}
                >
                  <button className="cwu-browser-row-main" onClick={() => actions.onSelect?.(session)} type="button">
                    <span
                      aria-hidden="true"
                      className={`cwu-browser-row-status cwu-status-${sessionStatusTone(session.status)}`}
                    />
                    <span className="cwu-browser-row-copy">
                      <strong>{session.title}</strong>
                      <small>{unread ? '新结果 · ' : ''}{view.groupMode === 'context' ? formatTime(session.updatedAt) : `${session.contextLabel} · ${formatTime(session.updatedAt)}`}</small>
                    </span>
                  </button>
                  {actions.onArchive && session.canArchive ? (
                    <button
                      aria-label={`${session.archived ? (labels.restore || '恢复') : (labels.archive || '归档')}：${session.title}`}
                      className="cwu-browser-row-action"
                      disabled={archivingIds.has(session.id)}
                      onClick={() => setArchived(session, !session.archived)}
                      title={session.archived ? (labels.restore || '恢复') : (labels.archive || '归档')}
                      type="button"
                    >{archivingIds.has(session.id) ? <span aria-hidden="true">…</span> : session.archived ? (
                      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                        <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                        <path d="M3 3v5h5" />
                      </svg>
                    ) : (
                      <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
                        <path d="M4 7h16" />
                        <path d="M5 7l1 13h12l1-13" />
                        <path d="M9 11v5M15 11v5M9 4h6l1 3H8l1-3Z" />
                      </svg>
                    )}</button>
                  ) : null}
                </div>
                );
              })}
              {projectGroup && hiddenCount > 0 ? (
                <button
                  className="cwu-browser-group-more"
                  onClick={() => toggleGroup(group.id)}
                  type="button"
                >{expanded ? '收起' : `展开更多 ${hiddenCount} 个`}</button>
              ) : null}
            </section>
            );
          })}
          {view.hasMore ? (
            <button
              className="cwu-browser-load-more"
              disabled={view.loadingMore}
              onClick={requestMore}
              ref={loadMoreRef}
              type="button"
            >{view.loadingMore ? (labels.loadingMore || '正在继续加载…') : (labels.loadMore || '继续加载')}</button>
          ) : null}
        </div>
        {undoArchive ? (
          <div className="cwu-browser-undo" role="status">
            <span title={undoArchive.title}>已归档「{undoArchive.title}」</span>
            <button onClick={() => { setArchived(undoArchive, false); setUndoArchive(null); }} type="button">{labels.undo || '撤销'}</button>
          </div>
        ) : null}
      </aside>

      <button
        aria-expanded={!listCollapsed}
        aria-label={listCollapsed ? (labels.expandList || '展开列表') : (labels.collapseList || '收起列表')}
        className="cwu-browser-list-toggle"
        onClick={toggleSessionList}
        title={listCollapsed ? (labels.expandList || '展开列表') : (labels.collapseList || '收起列表')}
        type="button"
      >{listCollapsed ? '›' : '‹'}</button>

      <section className="cwu-browser-detail" aria-label={labels.detailAriaLabel || 'Session 详情'}>
        {detail ? <SessionWorkspace key={detail.session?.sessionId || 'session-detail'} {...detail} /> : (
          <div className="cwu-browser-detail-empty">
            <span>{labels.detailEyebrow || 'Session 详情'}</span>
            <h2>{labels.detailEmptyTitle || '从左侧选择一个 Session'}</h2>
            <p>{labels.detailEmptyBody || '这里会展示完整对话、执行过程和后续输入框。'}</p>
          </div>
        )}
      </section>
    </div>
  );
}

export function SessionWorkspace({
  session,
  attachmentPolicy = {},
  documentPreview = null,
  actions = {},
  extensions = {},
  features = {},
  labels = {},
}) {
  const view = useMemo(() => normalizeSessionViewModel(session), [session]);
  const enabledFeatures = useMemo(() => normalizeSessionFeatures(features), [features]);
  const uploadPolicy = useMemo(() => normalizeAttachmentPolicy(attachmentPolicy), [attachmentPolicy]);
  const transcriptRef = useRef(null);
  const composerRef = useRef(null);
  const followLatestRef = useRef(true);
  const [draft, setDraft] = useState(view.draft);
  const [attachments, setAttachments] = useState([]);
  const [attachmentUploadState, setAttachmentUploadState] = useState({ status: 'idle', error: '' });
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [deletingQueuedIds, setDeletingQueuedIds] = useState(() => new Set());
  const running = view.status === 'running';
  const uploading = attachmentUploadState.status === 'uploading';
  const composerDisabled = view.composerDisabled || submitting;
  const executionControlsDisabled = composerDisabled || running || !actions.onExecutionProfileChange;
  const selectedExecutionModel = view.models.find((model) => model.id === view.executionProfile.model) || null;
  const executionEfforts = selectedExecutionModel?.reasoningEfforts?.length
    ? selectedExecutionModel.reasoningEfforts
    : ['low', 'medium', 'high', 'xhigh'];
  const fastTier = selectedExecutionModel?.serviceTiers.find((tier) => tier.id === 'priority') || null;
  const canSubmit = Boolean((draft.trim() || attachments.length) && !composerDisabled && !uploading && actions.onSubmit);
  const composer = sessionComposerPresentation({ running, submitting, canSteer: enabledFeatures.steer });
  const technicalByTurn = new Map();
  const lastMessageByTurn = new Map();
  const technicalDetailsAvailable = new Set(view.technicalDetailsAvailable);
  for (const item of view.technicalItems) {
    const key = item.turnId || 'unassigned';
    const values = technicalByTurn.get(key) || [];
    values.push(item);
    technicalByTurn.set(key, values);
  }
  for (const message of view.messages) {
    if (message.turnId) lastMessageByTurn.set(message.turnId, message.id);
  }

  useEffect(() => {
    followLatestRef.current = true;
    setDraft(view.draft);
    setAttachments([]);
    setAttachmentUploadState({ status: 'idle', error: '' });
    setAttachmentDragActive(false);
  }, [view.sessionId]);

  useEffect(() => {
    const target = transcriptRef.current;
    if (target && followLatestRef.current) target.scrollTop = target.scrollHeight;
  }, [view.sessionId, view.messages, view.status]);

  useEffect(() => {
    const target = composerRef.current;
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 220)}px`;
  }, [draft]);

  function followLatest() {
    followLatestRef.current = true;
    requestAnimationFrame(() => {
      const target = transcriptRef.current;
      if (target) target.scrollTop = target.scrollHeight;
    });
  }

  function updateFollowState(event) {
    const target = event.currentTarget;
    followLatestRef.current = target.scrollHeight - target.scrollTop - target.clientHeight < 120;
  }

  async function submit(mode = 'turn') {
    const prompt = draft.trim();
    if ((!prompt && !attachments.length) || submitting || uploading || !actions.onSubmit) return;
    const submittedDraft = draft;
    const submittedAttachments = attachments;
    followLatest();
    setSubmitting(true);
    setDraft('');
    setAttachments([]);
    setAttachmentUploadState({ status: 'idle', error: '' });
    try {
      await actions.onSubmit({
        prompt,
        mode,
        attachments: submittedAttachments,
      });
    } catch (error) {
      setDraft(submittedDraft);
      setAttachments(submittedAttachments);
      throw error;
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadFiles(fileList) {
    const availableSlots = Math.max(0, uploadPolicy.maxCount - attachments.length);
    const candidates = [...(fileList || [])].slice(0, availableSlots);
    if (!availableSlots && (fileList?.length || 0)) {
      setAttachmentUploadState({ status: 'error', error: `单次最多 ${uploadPolicy.maxCount} 个附件。` });
      return;
    }
    const files = candidates.filter((file) => (
      file.size <= uploadPolicy.maxBytes && fileMatchesAccept(file, uploadPolicy.accept)
    ));
    if (!actions.onUploadAttachments) return;
    if (!files.length) {
      if (candidates.length) {
        setAttachmentUploadState({ status: 'error', error: '附件不符合格式或大小限制。' });
      }
      return;
    }
    setAttachmentUploadState({ status: 'uploading', error: '' });
    const uploaded = [];
    const errors = candidates.length > files.length
      ? ['部分附件不符合格式或大小限制。']
      : [];
    for (const file of files) {
      try {
        uploaded.push(...((await actions.onUploadAttachments([file])) || []));
      } catch (error) {
        errors.push(error?.message || `${file.name} 上传失败`);
      }
    }
    if (uploaded.length) setAttachments((current) => [...current, ...uploaded].slice(0, uploadPolicy.maxCount));
    setAttachmentUploadState({
      status: errors.length ? 'error' : 'idle',
      error: errors[0] || '',
    });
  }

  async function uploadAttachments(event) {
    // FileList is live: clearing the input also empties the same object in Chromium.
    // Snapshot it first so the upload still receives the files the user selected.
    const files = [...(event.target.files || [])];
    event.target.value = '';
    await uploadFiles(files);
  }

  function handleAttachmentDrag(event) {
    if (!event.dataTransfer?.types?.includes('Files') || !actions.onUploadAttachments) return;
    event.preventDefault();
    if (composerDisabled || uploading || attachments.length >= uploadPolicy.maxCount) return;
    event.dataTransfer.dropEffect = 'copy';
    setAttachmentDragActive(true);
  }

  function handleAttachmentDragLeave(event) {
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setAttachmentDragActive(false);
  }

  async function handleAttachmentDrop(event) {
    if (!event.dataTransfer?.types?.includes('Files') || !actions.onUploadAttachments) return;
    event.preventDefault();
    setAttachmentDragActive(false);
    if (composerDisabled || uploading || attachments.length >= uploadPolicy.maxCount) return;
    await uploadFiles(event.dataTransfer.files);
  }

  async function handleComposerPaste(event) {
    if (!actions.onUploadAttachments || composerDisabled || uploading) return;
    const files = clipboardAttachmentFiles(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      await uploadFiles(files);
      return;
    }
    const text = event.clipboardData?.getData('text/plain') || '';
    if (!text || draft.length + text.length <= SESSION_COMPOSER_TEXT_LIMIT) return;
    event.preventDefault();
    await uploadFiles([new File(
      [text],
      `粘贴文本-${compactLocalTimestamp(new Date())}.txt`,
      { type: 'text/plain' },
    )]);
  }

  async function openSubagents() {
    setSubagentsOpen(true);
    await actions.onRefreshSubagents?.();
  }

  async function loadEarlier() {
    const target = transcriptRef.current;
    if (!target || !actions.onLoadEarlier || view.historyLoading) return;
    followLatestRef.current = false;
    const previousHeight = target.scrollHeight;
    const previousTop = target.scrollTop;
    await actions.onLoadEarlier();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const current = transcriptRef.current;
      if (current) current.scrollTop = previousTop + (current.scrollHeight - previousHeight);
    }));
  }

  async function deleteQueuedTurn(queuedTurnId) {
    if (!actions.onDeleteQueuedTurn || deletingQueuedIds.has(queuedTurnId)) return;
    setDeletingQueuedIds((current) => new Set(current).add(queuedTurnId));
    try {
      await actions.onDeleteQueuedTurn(queuedTurnId);
    } finally {
      setDeletingQueuedIds((current) => {
        const next = new Set(current);
        next.delete(queuedTurnId);
        return next;
      });
    }
  }

  function updateExecutionProfile(patch) {
    if (executionControlsDisabled) return;
    Promise.resolve(actions.onExecutionProfileChange({ ...view.executionProfile, ...patch }))
      .catch((error) => actions.onError?.(error));
  }

  return (
    <div className="cwu-session-shell" data-status={view.status}>
      {documentPreview ? (
        <DocumentPreview
          file={documentPreview}
          onClose={actions.onCloseDocument}
          onOpenExternal={actions.onOpenDocumentExternal}
          onOpenLink={actions.onOpenLink}
        />
      ) : null}
      <header className="cwu-session-header">
        <button className="cwu-quiet-button" onClick={actions.onBack} type="button">
          ← {labels.back || '返回'}
        </button>
        <div className="cwu-session-heading">
          <span>{view.contextLabel}</span>
          <h1>{view.title}</h1>
        </div>
        <div className="cwu-session-actions">
          {extensions.renderHeaderActions?.({ session: view }) || null}
          <SessionStatus label={view.statusLabel} state={view.status} tone={sessionStatusTone(view.status)} />
          {running && actions.onInterrupt ? (
            <button className="cwu-button" onClick={actions.onInterrupt} type="button">停止</button>
          ) : null}
          {enabledFeatures.subagents !== 'hidden'
            && (view.subagents.length || actions.onRefreshSubagents || actions.onOpenSubagent) ? (
            <button className="cwu-button" onClick={openSubagents} type="button">
              Agents{view.subagents.length ? ` ${view.subagents.length}` : ''}
            </button>
          ) : null}
          {enabledFeatures.realtime === 'visible' && actions.onRealtimeMessage ? (
            <RealtimePanel
              enabled={!running && view.status !== 'connecting' && view.status !== 'error'}
              event={session.realtimeEvent}
              initialState={session.realtime}
              labels={labels}
              onFallback={actions.onRealtimeFallback}
              onSend={actions.onRealtimeMessage}
            />
          ) : null}
          {enabledFeatures.externalLink === 'visible' && view.externalUrl ? (
            <a className="cwu-button" href={view.externalUrl}>{labels.externalLink || 'Agent App'}</a>
          ) : null}
        </div>
      </header>

      <main className="cwu-session-main">
        <agent-session-stream className="cwu-transcript" onScroll={updateFollowState} ref={transcriptRef}>
          {extensions.renderBeforeMessages?.({ session: view }) || null}
          <div className="cwu-message-column">
            {view.hasEarlierTurns && actions.onLoadEarlier ? (
              <div className="cwu-history-separator">
                <span />
                <button disabled={view.historyLoading} onClick={loadEarlier} type="button">
                  {view.historyLoading ? (labels.historyLoading || '正在加载…') : (labels.loadEarlier || '查看更早消息')}
                </button>
                {view.loadedTurnCount != null ? <small>已显示最近 {view.loadedTurnCount} 轮</small> : null}
                <span />
              </div>
            ) : view.loadedTurnCount ? (
              <div className="cwu-history-start"><span />{labels.historyStart || '已到最早消息'}<span /></div>
            ) : null}
            {view.messages.length ? view.messages.map((message) => (
              <React.Fragment key={message.id}>
                <Message
                  message={message}
                  onEditMessage={actions.onEditMessage}
                  onForkMessage={actions.onForkMessage}
                  onOpenLink={actions.onOpenLink}
                  renderContent={extensions.renderMessageContent}
                  session={view}
                  sessionId={view.sessionId}
                  visualizationUrl={actions.visualizationUrl}
                />
                {extensions.renderAfterMessage?.({ message, session: view }) || null}
                {enabledFeatures.technicalDetails
                  && message.turnId
                  && lastMessageByTurn.get(message.turnId) === message.id
                  && (technicalByTurn.get(message.turnId)?.length || technicalDetailsAvailable.has(message.turnId)) ? (
                    <TechnicalDetails
                      available={technicalDetailsAvailable.has(message.turnId)}
                      items={technicalByTurn.get(message.turnId) || []}
                      loading={view.technicalDetailsLoading}
                      onLoad={actions.onLoadTechnicalDetails
                        ? () => actions.onLoadTechnicalDetails(message.turnId)
                        : null}
                    />
                  ) : null}
              </React.Fragment>
            )) : (
              <div className="cwu-empty">
                <h2>{labels.emptyTitle || '开始处理这项工作'}</h2>
                <p>{labels.emptyBody || '输入需求后，这个 Session 会保留完整过程。'}</p>
              </div>
            )}

            {view.status === 'running' ? (
              <RuntimeProgress plan={view.plan} />
            ) : null}

            {view.pendingRequests.map((request) => (
              <SessionRequestCard
                key={request.token}
                request={request}
                onRespond={actions.onRespondToRequest}
              />
            ))}

            {enabledFeatures.technicalDetails && technicalByTurn.get('unassigned')?.length ? (
              <TechnicalDetails items={technicalByTurn.get('unassigned')} />
            ) : null}
            {extensions.renderAfterMessages?.({ session: view }) || null}
          </div>
        </agent-session-stream>

        <footer className="cwu-composer-wrap">
          {view.queuedTurns.length ? (
            <section aria-label={labels.queuedTitle || '下一轮待发送'} className="cwu-queued-turns">
              <header><strong>{labels.queuedTitle || '下一轮待发送'}</strong><span>{view.queuedTurns.length} 条</span></header>
              <div className="cwu-queued-turn-list">
                {view.queuedTurns.map((item) => (
                  <article key={item.id}>
                    <div>
                      <p>{item.prompt || labels.queuedAttachmentOnly || '附件消息'}</p>
                      {item.attachments.length ? <small>{item.attachments.map((attachment) => attachment.name).join(' · ')}</small> : null}
                    </div>
                    {actions.onDeleteQueuedTurn ? (
                      <button
                        aria-label={`删除下一轮消息：${item.prompt || '附件消息'}`}
                        disabled={deletingQueuedIds.has(item.id)}
                        onClick={() => deleteQueuedTurn(item.id)}
                        type="button"
                      >{deletingQueuedIds.has(item.id) ? '删除中…' : '删除'}</button>
                    ) : null}
                  </article>
                ))}
              </div>
            </section>
          ) : null}
          <agent-session-composer
            className={`cwu-composer ${attachmentDragActive ? 'is-dragging' : ''}`}
            onDragEnter={handleAttachmentDrag}
            onDragLeave={handleAttachmentDragLeave}
            onDragOver={handleAttachmentDrag}
            onDrop={handleAttachmentDrop}
          >
          {attachmentDragActive ? (
            <div className="cwu-attachment-dropzone" role="status">松开以上传附件</div>
          ) : null}
          <form className="cwu-composer-form" onSubmit={(event) => { event.preventDefault(); submit(composer.primaryMode); }}>
            {extensions.renderComposerOverlay?.({ draft, session: view, setDraft }) || null}
            {attachments.length || uploading || attachmentUploadState.error ? (
              <div className="cwu-attachments" aria-live="polite">
                {attachments.map((attachment) => (
                  <span className="cwu-attachment" key={attachment.id}>
                    <span title={attachment.name}>{attachment.name}</span>
                    <button
                      aria-label={`移除 ${attachment.name}`}
                      disabled={submitting}
                      onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                      type="button"
                    >×</button>
                  </span>
                ))}
                {uploading ? <span className="cwu-upload-status">上传中…</span> : null}
                {attachmentUploadState.error ? <span className="cwu-upload-error">{attachmentUploadState.error}</span> : null}
              </div>
            ) : null}
            <textarea
              aria-label={labels.composerPlaceholder || '输入需求'}
              disabled={composerDisabled}
              maxLength={SESSION_COMPOSER_TEXT_LIMIT}
              onChange={(event) => {
                setDraft(event.target.value);
                actions.onDraftChange?.(event.target.value);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  submit(composer.primaryMode);
                }
              }}
              onPaste={handleComposerPaste}
              placeholder={labels.composerPlaceholder || '补充需求、反馈问题，或者继续修改…'}
              ref={composerRef}
              rows={3}
              value={draft}
            />
            <div className="cwu-composer-footer">
              <div className="cwu-composer-meta">
                {enabledFeatures.attachments === 'visible' && actions.onUploadAttachments ? (
                  <label
                    aria-disabled={submitting || uploading || attachments.length >= uploadPolicy.maxCount}
                    className="cwu-attach-button"
                    title={attachments.length >= uploadPolicy.maxCount ? `单次最多 ${uploadPolicy.maxCount} 个附件` : '添加图片或附件'}
                  >
                    <input
                      accept={uploadPolicy.accept || undefined}
                      aria-label="添加图片或附件"
                      disabled={submitting || uploading || attachments.length >= uploadPolicy.maxCount}
                      multiple
                      onInput={uploadAttachments}
                      type="file"
                    />
                    <span aria-hidden="true">＋</span>附件
                  </label>
                ) : null}
                {view.models.length ? (
                  <div className="cwu-execution-controls" aria-label={labels.executionSettings || '执行设置'}>
                    <label title={labels.model || '模型'}>
                      <span>{labels.model || '模型'}</span>
                      <select
                        aria-label={labels.model || '模型'}
                        disabled={executionControlsDisabled}
                        onChange={(event) => {
                          const model = view.models.find((candidate) => candidate.id === event.target.value);
                          const supportedEfforts = model?.reasoningEfforts || [];
                          updateExecutionProfile({
                            model: event.target.value,
                            reasoningEffort: supportedEfforts.includes(view.executionProfile.reasoningEffort)
                              ? view.executionProfile.reasoningEffort
                              : model?.defaultReasoningEffort || 'medium',
                            serviceTier: model?.serviceTiers.some((tier) => tier.id === view.executionProfile.serviceTier)
                              ? view.executionProfile.serviceTier
                              : model?.defaultServiceTier || null,
                          });
                        }}
                        value={view.executionProfile.model}
                      >
                        {view.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                      </select>
                    </label>
                    <label title={labels.reasoning || '思考强度'}>
                      <span>{labels.reasoning || '思考'}</span>
                      <select
                        aria-label={labels.reasoning || '思考强度'}
                        disabled={executionControlsDisabled}
                        onChange={(event) => updateExecutionProfile({ reasoningEffort: event.target.value })}
                        value={view.executionProfile.reasoningEffort}
                      >
                        {executionEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabel(effort)}</option>)}
                      </select>
                    </label>
                    <label title={labels.permissions || '权限'}>
                      <span>{labels.permissions || '权限'}</span>
                      <select
                        aria-label={labels.permissions || '权限'}
                        disabled={executionControlsDisabled}
                        onChange={(event) => updateExecutionProfile({ accessMode: event.target.value })}
                        value={view.executionProfile.accessMode}
                      >
                        {view.accessModes.map((mode) => <option key={mode.id} value={mode.id}>{mode.label}</option>)}
                      </select>
                    </label>
                    <button
                      aria-label={labels.fastMode || 'Fast 模式'}
                      aria-pressed={view.executionProfile.serviceTier === 'priority'}
                      className="cwu-execution-fast"
                      disabled={executionControlsDisabled || !fastTier}
                      onClick={() => updateExecutionProfile({
                        serviceTier: view.executionProfile.serviceTier === 'priority' ? null : 'priority',
                      })}
                      title={fastTier?.description || labels.fastUnavailable || '当前模型不支持 Fast'}
                      type="button"
                    >⚡ Fast</button>
                  </div>
                ) : <span className="cwu-execution-profile">{view.executionProfile.label}</span>}
              </div>
              <div>
                {composer.showSecondary ? (
                  <button className="cwu-button" disabled={!canSubmit} onClick={() => submit(composer.secondaryMode)} type="button">
                    {composer.secondaryLabel}
                  </button>
                ) : null}
                <button className="cwu-send" disabled={!canSubmit} title={composer.primaryLabel} type="submit">
                  {composer.primaryLabel}
                </button>
              </div>
            </div>
          </form>
          </agent-session-composer>
        </footer>
      </main>
      {subagentsOpen ? (
        <div className="cwu-subagent-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setSubagentsOpen(false);
        }} role="presentation">
          <section aria-labelledby="cwu-subagent-title" className="cwu-subagent-dialog" role="dialog">
            <header>
              <div><span>Codex native</span><h2 id="cwu-subagent-title">子 Agent</h2></div>
              <div>
                {actions.onRefreshSubagents ? <button className="cwu-button" onClick={actions.onRefreshSubagents} type="button">刷新</button> : null}
                <button aria-label="关闭" className="cwu-subagent-close" onClick={() => setSubagentsOpen(false)} type="button">×</button>
              </div>
            </header>
            <p>来自当前 Session 的 Codex 子线程；项目归属仍由当前产品提供。</p>
            <agent-subagent-list className="cwu-subagent-list">
              {view.subagents.length ? view.subagents.map((agent) => (
                <SubagentCard actions={actions} agent={agent} key={agent.id} mode={enabledFeatures.subagents} />
              )) : <div className="cwu-subagent-empty">当前 Session 还没有子 Agent。</div>}
            </agent-subagent-list>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function SubagentCard({ agent, actions, mode = 'full' }) {
  const [stopping, setStopping] = useState(false);
  const title = [agent.nickname, agent.role].filter(Boolean).join(' · ') || agent.name;
  const meta = [agent.model, agent.reasoningEffort].filter(Boolean).join(' · ');
  async function stop() {
    if (!actions.onStopSubagent || stopping) return;
    setStopping(true);
    try { await actions.onStopSubagent(agent); } finally { setStopping(false); }
  }
  return (
    <agent-subagent-card className="cwu-subagent-card" data-state={agent.statusType}>
      <header><strong>{title}</strong><span>{agent.state ? `${agent.status} · ${agent.state}` : agent.status}</span></header>
      {mode === 'full' && meta ? <small>{meta}</small> : null}
      {mode === 'full' ? <p>{agent.prompt || agent.stateMessage || agent.name}</p> : null}
      {mode === 'full' ? (
        <div>
          {actions.onOpenSubagent ? <button className="cwu-button" onClick={() => actions.onOpenSubagent(agent)} type="button">打开线程</button> : null}
          {agent.canStop && actions.onStopSubagent ? (
            <button className="cwu-button cwu-danger" disabled={stopping} onClick={stop} type="button">
              {stopping ? '正在停止…' : '停止 Agent'}
            </button>
          ) : null}
        </div>
      ) : null}
    </agent-subagent-card>
  );
}

export function SessionStatus({ label = '空闲', state = 'idle', tone = 'idle' }) {
  return <agent-session-status label={label} state={state} tone={tone} />;
}

function RealtimePanel({ enabled, event, initialState, labels, onFallback, onSend }) {
  const launchRef = useRef(null);
  const dialogRef = useRef(null);
  const dismissRef = useRef(null);
  const startRef = useRef(null);
  const stopRef = useRef(null);
  const fallbackRef = useRef(null);
  const voiceRef = useRef(null);
  const statusRef = useRef(null);
  const transcriptRef = useRef(null);
  const errorRef = useRef(null);
  const outputRef = useRef(null);
  const controllerRef = useRef(null);
  const sendRef = useRef(onSend);
  const fallbackActionRef = useRef(onFallback);

  useEffect(() => {
    sendRef.current = onSend;
    fallbackActionRef.current = onFallback;
  }, [onFallback, onSend]);

  useEffect(() => {
    const factory = globalThis.window?.AgentRealtime?.create;
    if (!factory) return undefined;
    let controller;
    controller = factory({
      launchButton: launchRef.current,
      dialog: dialogRef.current,
      dismissButton: dismissRef.current,
      startButton: startRef.current,
      stopButton: stopRef.current,
      fallbackButton: fallbackRef.current,
      voiceSelect: voiceRef.current,
      statusElement: statusRef.current,
      transcriptElement: transcriptRef.current,
      errorElement: errorRef.current,
      outputAudio: outputRef.current,
      send: (message) => {
        Promise.resolve(sendRef.current?.(message)).catch((error) => {
          controller.handleMessage('realtime-error', { message: error?.message || '实时语音请求失败。' });
        });
        return true;
      },
      fallbackToDictation: () => fallbackActionRef.current?.(),
    });
    controllerRef.current = controller;
    controller.install();
    if (initialState) controller.handleMessage('realtime-state', initialState);
    return () => {
      controller.handleMessage('realtime-state', { status: 'idle', transcript: [] });
      controllerRef.current = null;
    };
  }, []);

  useEffect(() => {
    controllerRef.current?.setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    if (!event?.type) return;
    controllerRef.current?.handleMessage(event.type, event.payload || {});
  }, [event]);

  return (
    <>
      <button className="cwu-button cwu-realtime-launch" ref={launchRef} title="Realtime V3" type="button">
        {labels.realtimeButton || '语音'}
      </button>
      <dialog className="cwu-realtime-dialog" ref={dialogRef}>
        <section className="cwu-realtime-shell">
          <header>
            <div><span>Experimental · Realtime V3</span><h2>{labels.realtimeTitle || '实时语音对话'}</h2></div>
            <button aria-label="收起" className="cwu-realtime-close" ref={dismissRef} type="button">×</button>
          </header>
          <div className="cwu-realtime-controls">
            <label><span>声音</span><select defaultValue="juniper" ref={voiceRef}><option value="juniper">juniper</option></select></label>
            <strong data-state="idle" ref={statusRef}>尚未开始</strong>
          </div>
          <audio autoPlay hidden playsInline ref={outputRef} />
          <div aria-live="polite" className="cwu-realtime-transcript" ref={transcriptRef} />
          <p className="cwu-realtime-error hidden" ref={errorRef} />
          <div className="cwu-realtime-actions">
            <button ref={fallbackRef} type="button">改用文字输入</button>
            <button disabled ref={stopRef} type="button">停止</button>
            <button className="cwu-send" ref={startRef} type="button">开始实时对话</button>
          </div>
        </section>
      </dialog>
    </>
  );
}

function markdownLinkComponents(onOpenLink) {
  if (!onOpenLink) return undefined;
  return {
    a: ({ href = '', children, ...props }) => (
      <a
        {...props}
        href={href}
        onClick={(event) => {
          event.preventDefault();
          onOpenLink(href);
        }}
      >{children}</a>
    ),
  };
}

function DocumentPreview({ file, onClose, onOpenExternal, onOpenLink }) {
  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') onClose?.();
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <div
      aria-label={`文件预览：${file.name}`}
      aria-modal="true"
      className="cwu-document-backdrop"
      onMouseDown={(event) => { if (event.target === event.currentTarget) onClose?.(); }}
      role="dialog"
    >
      <section className="cwu-document-preview">
        <header>
          <div><span>本地文件 · 只读</span><h2>{file.name}</h2></div>
          <div>
            {onOpenExternal ? <button className="cwu-button" onClick={() => onOpenExternal(file)} type="button">外部打开</button> : null}
            <button aria-label="关闭文件预览" className="cwu-document-close" onClick={onClose} type="button">×</button>
          </div>
        </header>
        <div className="cwu-document-body">
          {file.format === 'spreadsheet' ? (
            <SpreadsheetPreview file={file} />
          ) : file.format === 'markdown' ? (
            <div className="cwu-document-content cwu-message-body">
              <ReactMarkdown components={markdownLinkComponents(onOpenLink)} remarkPlugins={[remarkGfm]}>{file.content || ''}</ReactMarkdown>
            </div>
          ) : <pre className="cwu-document-code">{file.content || ''}</pre>}
        </div>
      </section>
    </div>
  );
}

function SpreadsheetPreview({ file }) {
  const [activeSheet, setActiveSheet] = useState(0);
  const sheets = Array.isArray(file.sheets) ? file.sheets : [];
  const sheet = sheets[Math.min(activeSheet, Math.max(0, sheets.length - 1))];
  if (!sheet) return <div className="cwu-spreadsheet-empty">这个工作簿没有可显示的工作表</div>;
  return (
    <div className="cwu-spreadsheet-preview">
      <nav aria-label="工作表">
        {sheets.map((item, index) => (
          <button
            aria-pressed={index === activeSheet}
            key={`${item.name}-${index}`}
            onClick={() => setActiveSheet(index)}
            type="button"
          >{item.name || `Sheet ${index + 1}`}</button>
        ))}
      </nav>
      <div className="cwu-spreadsheet-scroll">
        <table>
          <tbody>
            {(sheet.rows || []).map((row, rowIndex) => (
              <tr key={rowIndex}>
                {(row || []).map((cell, columnIndex) => {
                  const Cell = rowIndex === 0 ? 'th' : 'td';
                  return <Cell key={columnIndex}>{cell}</Cell>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {sheet.truncated ? <p className="cwu-spreadsheet-note">工作表较大，页面仅显示前 {sheet.rows.length} 行；完整内容请外部打开。</p> : null}
    </div>
  );
}

function Message({
  message,
  onEditMessage,
  onForkMessage,
  onOpenLink,
  renderContent,
  session,
  sessionId,
  visualizationUrl,
}) {
  const isUser = message.role === 'user';
  const isCommentary = message.phase === 'commentary';
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [savingEdit, setSavingEdit] = useState(false);
  const [forking, setForking] = useState(false);
  const canEdit = isUser && message.canEdit && typeof onEditMessage === 'function';
  const canFork = isUser && message.canFork && typeof onForkMessage === 'function';
  const markdownComponents = markdownLinkComponents(onOpenLink);
  const inline = extractInlineVisualizations(message.content);
  const visualizations = typeof visualizationUrl === 'function'
    ? inline.files.map((file) => ({
        file,
        src: visualizationUrl({ file, messageId: message.id, sessionId }),
      })).filter((item) => item.src)
    : [];
  const directiveContent = extractRemarkDirectives(visualizations.length ? inline.markdown : message.content);
  const renderedContent = renderFileCitationsAsMarkdown(directiveContent.markdown);
  const visibleAttachments = isUser
    ? (message.attachments || []).filter((attachment) => (
        attachment.kind !== 'image' || !message.media?.length
      ))
    : [];
  const defaultContent = isUser
    ? renderedContent
    : <>
        {renderedContent ? <ReactMarkdown components={markdownComponents} remarkPlugins={[remarkGfm]}>{renderedContent}</ReactMarkdown> : null}
        {!renderedContent && !visualizations.length && !directiveContent.directives.length ? '…' : null}
      </>;
  const customContent = renderContent?.({
    content: renderedContent,
    defaultContent,
    message,
    session,
  });

  async function saveEdit() {
    const prompt = editDraft.trim();
    if (!prompt || savingEdit || !canEdit) return;
    setSavingEdit(true);
    try {
      await onEditMessage({ messageId: message.id, turnId: message.turnId, prompt });
      setEditing(false);
    } finally {
      setSavingEdit(false);
    }
  }

  async function forkMessage() {
    if (forking || !canFork) return;
    setForking(true);
    try {
      await onForkMessage({ messageId: message.id, turnId: message.turnId, prompt: message.content });
    } finally {
      setForking(false);
    }
  }

  return (
    <agent-session-message className={`cwu-message ${isUser ? 'is-user' : isCommentary ? 'is-commentary' : 'is-assistant'} ${editing ? 'is-editing' : ''}`} data-message-id={message.id} phase={message.phase} role={message.role}>
      {isCommentary ? <div className="cwu-message-label">{message.label}</div> : null}
      {editing ? (
        <div className="cwu-message-editor">
          <textarea
            aria-label="编辑消息"
            autoFocus
            disabled={savingEdit}
            onChange={(event) => setEditDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setEditing(false);
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') saveEdit();
            }}
            rows={Math.min(8, Math.max(2, editDraft.split('\n').length))}
            value={editDraft}
          />
          <div>
            <button disabled={savingEdit} onClick={() => setEditing(false)} type="button">取消</button>
            <button disabled={savingEdit || !editDraft.trim()} onClick={saveEdit} type="button">
              {savingEdit ? '发送中…' : '发送'}
            </button>
          </div>
        </div>
      ) : (
        <div className="cwu-message-body">
          {customContent === undefined ? defaultContent : customContent}
          {!isUser ? <RemarkDirectives directives={directiveContent.directives} onOpenLink={onOpenLink} /> : null}
        </div>
      )}
      {!editing && (canEdit || canFork) ? (
        <div className="cwu-message-actions" aria-label="消息操作">
          {canEdit ? (
            <button onClick={() => { setEditDraft(message.content); setEditing(true); }} type="button">编辑</button>
          ) : null}
          {canFork ? (
            <button disabled={forking} onClick={forkMessage} type="button">{forking ? 'Fork 中…' : 'Fork'}</button>
          ) : null}
        </div>
      ) : null}
      {message.media?.length ? <MediaGallery items={message.media} /> : null}
      {visualizations.map((item) => (
        <div className="cwu-inline-visualization" key={item.file}>
          <iframe
            loading="lazy"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts"
            src={item.src}
            title={item.file}
          />
          <a href={item.src} rel="noreferrer" target="_blank">在新窗口打开</a>
        </div>
      ))}
      {visibleAttachments.length ? (
        <div className="cwu-message-attachments" aria-label="本轮附件">
          {visibleAttachments.map((attachment) => (
            <span key={attachment.id} title={attachment.name}>
              <i aria-hidden="true">{attachment.kind === 'image' ? '▧' : attachment.kind === 'audio' ? '♪' : '▤'}</i>
              {attachment.name}
            </span>
          ))}
        </div>
      ) : null}
    </agent-session-message>
  );
}

function RemarkDirectives({ directives, onOpenLink }) {
  if (!directives?.length) return null;
  return <div className="cwu-remark-directives">
    {directives.map((directive, index) => {
      const attributes = directive.attributes || {};
      if (directive.name === 'archive' || directive.name === 'codex-realtime-inline') return null;
      if (directive.name === 'inbox-item') return (
        <aside className="cwu-remark-card is-inbox" key={`${directive.name}-${index}`}>
          <span>自动任务</span>
          <strong>{attributes.title || '任务更新'}</strong>
          {attributes.summary ? <p>{attributes.summary}</p> : null}
        </aside>
      );
      if (directive.name === 'created-thread') {
        const threadId = attributes.threadId || attributes.clientThreadId;
        return (
          <aside className="cwu-remark-card" key={`${directive.name}-${index}`}>
            <span>新 Session</span>
            <strong>{threadId || '已创建'}</strong>
            {threadId && onOpenLink ? <button onClick={() => onOpenLink(`codex://threads/${threadId}`)} type="button">打开</button> : null}
          </aside>
        );
      }
      const values = Object.values(attributes).filter(Boolean);
      return (
        <aside className="cwu-remark-card" key={`${directive.name}-${index}`}>
          <span>{directive.name.replace(/-/g, ' ')}</span>
          <strong>{attributes.title || values[0] || '结构化结果'}</strong>
          {attributes.summary || attributes.body ? <p>{attributes.summary || attributes.body}</p> : null}
        </aside>
      );
    })}
  </div>;
}

function MediaGallery({ items }) {
  return (
    <div className="cwu-message-media" aria-label="消息图片">
      {items.map((item) => (
        <a href={item.src} key={item.id} rel="noreferrer" target="_blank">
          <img alt={item.alt} loading="lazy" src={item.src} />
        </a>
      ))}
    </div>
  );
}

function TechnicalDetails({ items, available = false, loading = false, onLoad = null }) {
  const [open, setOpen] = useState(false);
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !items.length && available && onLoad && !loading) await onLoad();
  }
  return (
    <section className="cwu-technical">
      <button
        aria-expanded={open}
        className="cwu-technical-toggle"
        onClick={toggle}
        type="button"
      >
        <span>本轮执行详情</span>
        <small>{items.length ? `${items.length} 项 · ` : ''}{loading && open ? '读取中…' : open ? '收起' : '展开'}</small>
      </button>
      {open ? (
        <div className="cwu-technical-list">
          {items.length ? items.map((item) => (
            <details key={item.id} open={item.status === 'inProgress'}>
              <summary><span>{item.title}</span><em>{item.status}</em></summary>
              {item.detail ? <pre>{item.detail}</pre> : null}
              {item.media?.length ? <MediaGallery items={item.media} /> : null}
            </details>
          )) : <p className="cwu-technical-loading">{loading ? '正在读取执行详情…' : '没有可展示的执行详情。'}</p>}
        </div>
      ) : null}
    </section>
  );
}

function RuntimeProgress({ plan }) {
  return (
    <section className="cwu-progress" aria-live="polite">
      <div className="cwu-progress-title"><i aria-hidden="true" />正在处理</div>
      {plan.length ? (
        <ol>{plan.map((step) => <li data-status={step.status} key={step.id}>{step.text}</li>)}</ol>
      ) : <p>Agent 正在继续处理，新的进展会自动出现。</p>}
    </section>
  );
}

export function SessionRequestCard({ request, onRespond }) {
  if (!onRespond) return null;
  if (request.kind === 'item/tool/requestUserInput') {
    return <SessionUserInputCard onRespond={onRespond} request={request} />;
  }
  return (
    <section className="cwu-request">
      <div><strong>{request.title}</strong><p>{request.detail}</p></div>
      <div>
        <button className="cwu-button" onClick={() => onRespond({ token: request.token, decision: 'decline' })} type="button">拒绝</button>
        <button className="cwu-button" onClick={() => onRespond({ token: request.token, decision: 'acceptForSession' })} type="button">本 Session 允许</button>
        <button className="cwu-send" onClick={() => onRespond({ token: request.token, decision: 'accept' })} type="button">允许一次</button>
      </div>
    </section>
  );
}

export function SessionUserInputCard({ request, onRespond }) {
  const input = useSessionUserInput({ onRespond, request });
  const {
    answers,
    choose,
    complete,
    containsSecret,
    questions,
    saving,
    submit,
  } = input;

  return (
    <section className="cwu-user-input" aria-label="需要你的选择">
      <div className="cwu-user-input-heading">
        <strong>需要你的选择</strong>
        <span>{containsSecret ? '敏感信息请在安全配置入口提供' : '提交后 Agent 会继续'}</span>
      </div>
      {questions.map((question) => (
        <div className="cwu-user-input-question" key={question.id}>
          <div>{question.header ? <strong>{question.header}</strong> : null}<span>{question.question}</span></div>
          {question.isSecret ? null : question.options.length ? (
            <div className="cwu-user-input-options">
              {question.options.map((option) => (
                <button
                  aria-pressed={answers[question.id] === option.label}
                  className={answers[question.id] === option.label ? 'is-selected' : ''}
                  disabled={saving}
                  key={option.label}
                  onClick={() => choose(question.id, option.label)}
                  type="button"
                >
                  <strong>{option.label}</strong>
                  {option.description ? <span>{option.description}</span> : null}
                </button>
              ))}
            </div>
          ) : (
            <input
              aria-label={question.header || question.question}
              disabled={saving}
              maxLength={2000}
              onChange={(event) => choose(question.id, event.target.value)}
              placeholder="输入回答"
              type="text"
              value={answers[question.id] || ''}
            />
          )}
        </div>
      ))}
      <button className="cwu-send" disabled={!complete || containsSecret || saving} onClick={() => submit().catch(() => {})} type="button">
        {saving ? '提交中…' : '提交并继续'}
      </button>
    </section>
  );
}

function defaultFormatTime(value) {
  if (!value) return '时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function reasoningEffortLabel(effort) {
  return ({ low: '低', medium: '标准', high: '高', xhigh: '更高', ultra: '极高' })[effort] || effort;
}

function fileMatchesAccept(file, accept) {
  const rules = String(accept || '').split(',').map((rule) => rule.trim().toLowerCase()).filter(Boolean);
  if (!rules.length) return true;
  const name = String(file?.name || '').toLowerCase();
  const mimeType = String(file?.type || '').toLowerCase();
  return rules.some((rule) => {
    if (rule.startsWith('.')) return name.endsWith(rule);
    if (rule.endsWith('/*')) return mimeType.startsWith(rule.slice(0, -1));
    return mimeType === rule;
  });
}

function compactLocalTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

export {
  clipboardAttachmentFiles,
  groupSessionSummaries,
  normalizeSessionBrowserViewModel,
  normalizeSessionViewModel,
  normalizeSideChatPanelViewModel,
  sessionStatusTone,
} from './model.js';
