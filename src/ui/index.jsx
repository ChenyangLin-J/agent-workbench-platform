import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { SessionMarkdown } from './markdown.jsx';
import '../browser/realtime-controller.js';
import '../browser/session-status-element.js';
import '../browser/session-ui-elements.js';
import '../browser/subagent-elements.js';

import {
  appendComposerReferences,
  attachmentDragLeavesTarget,
  clipboardAttachmentFiles,
  composerDropPayload,
  dataTransferHasFiles,
  documentPreviewPresentation,
  groupSessionMessages,
  groupSessionSummaries,
  isDocumentResourceHref,
  isLocalFileHref,
  localFileBrowserHref,
  markdownHeadingId,
  extractVisualizationReferences,
  extractRemarkDirectives,
  normalizeMarkdownMath,
  normalizeCapabilityManagerViewModel,
  normalizeSessionBrowserViewModel,
  normalizeSessionViewModel,
  normalizeSideChatPanelViewModel,
  renderFileCitationsAsMarkdown,
  resolveDocumentResourceHref,
  richClipboardHasComplexStructure,
  richClipboardText,
  sessionTranscriptAwayFromLatest,
  sessionStatusTone,
  shouldConvertPastedTextToAttachment,
  technicalProcessSummary,
  technicalProcessNeedsDisclosure,
  mergeTechnicalItems,
  technicalItemsWindow,
  technicalGroupsInWindow,
  technicalGroupSummary,
  technicalStatusLabel,
  technicalSubagentOperationLabel,
  turnDurationLabel,
} from './model.js';
import { sessionComposerPresentation, sessionMessagePublishesMedia } from '../session.js';
import { normalizeSessionFeatures } from '../capabilities.js';
import { createSessionUiStateStore } from './session-ui-state.js';
import { normalizeAttachmentPolicy, normalizeSessionAttachment } from '../attachments.js';
import {
  MAX_SESSION_REFERENCES,
  composerSessionMention,
  dataTransferHasSessionReference,
  normalizeSessionReferences,
  removeComposerSessionMention,
  sessionReferenceFromDataTransfer,
  sessionReferenceKey,
  setSessionReferenceDataTransfer,
} from '../session-references.js';
import { tokenizeSqlPreview } from '../file-preview.js';
import { useSessionUserInput } from '../ui-hooks.js';

export { useSessionUserInput } from '../ui-hooks.js';

const SESSION_COMPOSER_TEXT_LIMIT = 12000;
let temporaryAttachmentSequence = 0;

export function CapabilityPanel({ manager, actions = {}, labels = {} }) {
  const view = useMemo(() => normalizeCapabilityManagerViewModel(manager), [manager]);
  const [pendingId, setPendingId] = useState(null);
  const [componentPreview, setComponentPreview] = useState(null);
  const kinds = ['skill-source', 'mcp-server', 'cli-tool', 'credential-provider'];

  useEffect(() => {
    if (!componentPreview) return undefined;
    const closeOnEscape = (event) => { if (event.key === 'Escape') setComponentPreview(null); };
    globalThis.addEventListener?.('keydown', closeOnEscape);
    return () => globalThis.removeEventListener?.('keydown', closeOnEscape);
  }, [componentPreview]);

  async function toggle(item) {
    if (!actions.onToggle || pendingId) return;
    setPendingId(item.id);
    try { await actions.onToggle(item.id, !item.enabled); } finally { setPendingId(null); }
  }

  async function runAction(item) {
    if (!actions.onPlan || !actions.onExecute || pendingId) return;
    setPendingId(item.id);
    try {
      const plan = await actions.onPlan(item.id, item.action?.operation || 'install');
      if (plan?.status !== 'action-required') return;
      const confirmed = actions.onConfirm
        ? await actions.onConfirm(plan, item)
        : globalThis.confirm?.(`${plan.title}\n\n${plan.detail || labels.confirmDetail || 'This action changes the host environment.'}`) === true;
      if (confirmed) await actions.onExecute(item.id, plan.operation, true);
    } finally {
      setPendingId(null);
    }
  }

  async function inspectComponent(item, component) {
    if (!actions.onInspectComponent) return;
    setComponentPreview({ title: component, loading: true, content: '' });
    try {
      const preview = await actions.onInspectComponent(item.id, component);
      setComponentPreview({ title: preview?.title || component, loading: false, content: String(preview?.content || '') });
    } catch (error) {
      setComponentPreview({ title: component, loading: false, error: error?.message || String(error), content: '' });
    }
  }

  return (
    <section className="cwu-capability-panel">
      <header>
        <div><span>{labels.eyebrow || 'Portable runtime'}</span><h1>{labels.title || 'Capabilities'}</h1></div>
        {actions.onRefresh ? <button className="cwu-button" onClick={actions.onRefresh} type="button">{labels.refresh || 'Refresh'}</button> : null}
      </header>
      <div className="cwu-capability-summary" aria-live="polite">
        <strong>{view.counts.enabled} {labels.enabled || 'enabled'}</strong>
        <span>{view.counts.healthy}/{view.counts.enabled} {labels.available || 'available'}</span>
        <span>{view.counts.common} {labels.common || 'common'}</span>
        <span>{view.counts.custom} {labels.custom || 'custom'}</span>
      </div>
      <div className="cwu-capability-sections">
        {kinds.map((kind) => {
          const items = view.capabilities.filter((item) => item.kind === kind);
          if (!items.length) return null;
          return (
            <section className="cwu-capability-group" key={kind}>
              <header><h2>{items[0].kindLabel}</h2><span>{items.filter((item) => item.enabled).length}/{items.length}</span></header>
              <div className="cwu-capability-grid">
                {items.map((item) => (
                  <article className={`cwu-capability-card ${item.enabled ? 'is-enabled' : ''} ${item.available ? 'is-healthy' : ''}`} key={item.id}>
                    <div>
                      <div className="cwu-capability-title"><h3>{item.title}</h3><span>{item.scope}</span></div>
                      <code>{item.id}{item.version ? ` · ${item.version}` : ''}</code>
                      <p className="cwu-capability-health"><i />{item.enabled ? item.available ? labels.ready || 'Enabled · available' : labels.needsSetup || 'Enabled · setup required' : labels.disabled || 'Disabled'}</p>
                      {item.detail ? <p>{item.detail}</p> : null}
                      {item.requiredBy.length ? <small>{labels.requiredBy || 'Required by'}: {item.requiredBy.join(', ')}</small> : item.dependencies.length ? <small>{labels.dependencies || 'Dependencies'}: {item.dependencies.join(', ')}</small> : null}
                      {item.kind === 'skill-source' && item.components.length ? (
                        <details className="cwu-capability-components">
                          <summary>{labels.components || 'View Skills'} ({item.components.length})</summary>
                          <div>{item.components.map((component) => (
                            <button disabled={!actions.onInspectComponent} key={component} onClick={() => inspectComponent(item, component)} type="button">{component}</button>
                          ))}</div>
                        </details>
                      ) : null}
                      {item.action?.instructions.map((instruction) => <code key={instruction}>{instruction}</code>)}
                    </div>
                    <div className="cwu-capability-actions">
                      <button aria-checked={item.enabled} disabled={!actions.onToggle || pendingId === item.id} onClick={() => toggle(item)} role="switch" type="button"><span />{item.enabled ? labels.on || 'On' : labels.off || 'Off'}</button>
                      {item.enabled && !item.available && item.action?.status === 'action-required' ? <button className="cwu-button" disabled={pendingId === item.id} onClick={() => runAction(item)} type="button">{item.action.title}</button> : null}
                    </div>
                  </article>
                ))}
              </div>
            </section>
          );
        })}
      </div>
      {componentPreview ? (
        <div className="cwu-capability-preview-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setComponentPreview(null); }}>
          <section aria-modal="true" className="cwu-capability-preview" role="dialog">
            <header>
              <div><span>SKILL.md</span><h2>{componentPreview.title}</h2></div>
              <button aria-label={labels.closePreview || 'Close'} onClick={() => setComponentPreview(null)} type="button">×</button>
            </header>
            <div className="cwu-capability-preview-content">
              {componentPreview.loading ? <p>{labels.loadingPreview || 'Loading…'}</p> : null}
              {componentPreview.error ? <p role="alert">{componentPreview.error}</p> : null}
              {!componentPreview.loading && !componentPreview.error ? <SessionMarkdown>{componentPreview.content}</SessionMarkdown> : null}
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export function SideChatPanel({
  panel,
  actions = {},
  labels = {},
  singleChat = false,
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
      {singleChat ? (selected && actions.onDelete ? <div className="cwu-side-chat-single-actions"><button type="button" disabled={busy || running} onClick={() => run(() => actions.onDelete(selected.id))}>{labels.delete || '删除 Side Chat'}</button></div> : null) : <div className="cwu-side-chat-tabs" role="tablist" aria-label={labels.tabsAriaLabel || 'Side Chats'}>
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
      </div>}

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

export function SubagentPanel({ panel = {}, actions = {}, labels = {} }) {
  const agents = Array.isArray(panel.agents) ? panel.agents : [];
  const detail = panel.selected || null;
  if (!detail) {
    return (
      <section className="cwu-subagent-panel" aria-label={labels.ariaLabel || 'Subagents'}>
        {agents.length ? agents.map((agent) => (
          <SubagentCard
            actions={{
              onOpenSubagent: actions.onSelect,
              onStopSubagent: actions.onStop,
            }}
            agent={agent}
            key={agent.id}
            mode="full"
            openLabel={labels.detail || '查看链路'}
          />
        )) : (
          <div className="cwu-subagent-panel-empty">
            <strong>{labels.emptyTitle || '暂无 Subagent'}</strong>
            <p>{labels.emptyBody || '由主 Agent 派发后，会在这里显示运行配置、状态与完整执行链路。'}</p>
          </div>
        )}
      </section>
    );
  }
  const agent = detail.subagent || detail.agent || {};
  const chain = [
    ...(detail.parent ? [{
      id: 'parent', title: labels.parent || '父 Session',
      detail: detail.parent.name || detail.parent.id || labels.mainSession || '主 Session', status: 'completed',
    }] : []),
    ...(detail.chain || []),
  ];
  return (
    <section className="cwu-subagent-panel is-detail" aria-label={labels.detailAriaLabel || 'Subagent 执行链路'}>
      <header className="cwu-subagent-panel-head">
        <button onClick={() => actions.onBack?.()} type="button">{labels.back || '← 返回'}</button>
        <div>
          <strong>{agent.nickname || agent.role || agent.name || 'Subagent'}</strong>
          <span>{[agent.model, agent.reasoningEffort].filter(Boolean).join(' · ') || labels.inheritedConfig || '配置由主 Agent 派发'}</span>
        </div>
      </header>
      <div className="cwu-subagent-chain">
        {chain.map((step, index) => (
          <article className="cwu-subagent-step" data-status={step.status || 'unknown'} key={step.id || `step-${index}`}>
            <i aria-hidden="true" />
            <div><strong>{step.title || step.type || '执行步骤'}</strong>{step.detail ? <p>{step.detail}</p> : null}</div>
          </article>
        ))}
      </div>
      <footer className="cwu-subagent-panel-actions">
        {actions.onOpen ? <button className="cwu-button" onClick={() => actions.onOpen(agent)} type="button">{labels.open || '作为 Session 打开'}</button> : null}
        {agent.canStop && actions.onStop ? <button className="cwu-button cwu-danger" onClick={() => actions.onStop(agent)} type="button">{labels.stop || '停止 Agent'}</button> : null}
      </footer>
    </section>
  );
}

export function SessionBrowser({
  browser,
  detail = null,
  actions = {},
  extensions = {},
  labels = {},
  listOnly = false,
}) {
  const view = useMemo(() => normalizeSessionBrowserViewModel(browser), [browser]);
  const sessionUiState = useRef(null);
  if (!sessionUiState.current) {
    let storage = null;
    try { storage = globalThis.sessionStorage; } catch { /* Storage is optional. */ }
    sessionUiState.current = createSessionUiStateStore(storage);
  }
  const [searchQuery, setSearchQuery] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [archivingIds, setArchivingIds] = useState(() => new Set());
  const [endingIds, setEndingIds] = useState(() => new Set());
  const [favoritingIds, setFavoritingIds] = useState(() => new Set());
  const [undoArchive, setUndoArchive] = useState(null);
  const visibleSessions = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase();
    if (!query) return view.sessions;
    return view.sessions.filter((session) => (
      `${session.title} ${session.contextLabel} ${session.searchableText}`.toLocaleLowerCase().includes(query)
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
  const listRef = useRef(null);
  const listToggleRef = useRef(null);
  const drawerTouchRef = useRef(null);
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

  const listCollapsed = listOnly ? false : isNarrow && detail ? !narrowListOpen : view.listCollapsed;
  const browserDocumentPreview = detail?.documentPreview || null;
  const drawerMode = isNarrow || browser.listMode === 'drawer';
  useEffect(() => {
    if (!drawerMode || listCollapsed || browserDocumentPreview) return;
    const listElement = listRef.current;
    const selectedButton = listElement?.querySelector('.is-active .cwu-browser-row-main');
    (selectedButton || listToggleRef.current)?.focus();
    function onKey(event) {
      if (event.key === 'Escape') { event.preventDefault(); closeSessionList(); return; }
      if (event.key !== 'Tab') return;
      const targets = [listToggleRef.current, ...listElement.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),summary')].filter(Boolean);
      const first = targets[0], last = targets.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); listToggleRef.current?.focus(); };
  }, [drawerMode, listCollapsed, browserDocumentPreview]);
  function closeSessionList() {
    if (isNarrow && detail) setNarrowListOpen(false);
    else actions.onToggleList?.(true);
  }

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

  useEffect(() => {
    if (view.paginationMode !== 'complete' || !view.hasMore || view.loadingMore || !actions.onLoadMore) return;
    requestMore();
  }, [actions.onLoadMore, view.hasMore, view.loadingMore, view.paginationMode, view.sessions.length]);

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
      const result = await actions.onArchive(session, archived);
      setUndoArchive(result === false ? null : archived ? session : null);
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

  async function setFavorited(session, favorited) {
    if (!actions.onFavorite || favoritingIds.has(session.id)) return;
    setFavoritingIds((current) => new Set(current).add(session.id));
    try {
      await actions.onFavorite(session, favorited);
    } finally {
      setFavoritingIds((current) => {
        const next = new Set(current);
        next.delete(session.id);
        return next;
      });
    }
  }

  async function endSession(session) {
    if (!actions.onEnd || endingIds.has(session.id)) return;
    setEndingIds((current) => new Set(current).add(session.id));
    try {
      await actions.onEnd(session);
    } finally {
      setEndingIds((current) => {
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
  const list = (
      <aside
        aria-hidden={listOnly ? undefined : Boolean(browserDocumentPreview) || listCollapsed}
        aria-label={labels.listAriaLabel || 'Session 列表'}
        className={`cwu-browser-list ${listOnly ? 'is-standalone' : ''}`}
        inert={browserDocumentPreview || listCollapsed ? true : undefined}
        ref={listRef}
        onTouchStart={(event) => { drawerTouchRef.current = { x: event.touches[0].clientX, y: event.touches[0].clientY }; }}
        onTouchEnd={(event) => {
          const start = drawerTouchRef.current;
          const touch = event.changedTouches[0];
          if (drawerMode && start && touch && touch.clientX - start.x < -70 && Math.abs(touch.clientY - start.y) < 40) closeSessionList();
          drawerTouchRef.current = null;
        }}
      >
        <header className="cwu-browser-summary">
          {browser.showSessionCount !== false ? <span>{view.loading && !view.sessions.length
            ? (labels.loading || '正在读取 Sessions…')
            : `${view.sessions.length}${view.hasMore ? '+' : ''}${labels.countSuffix || '个 Session'}`}</span> : null}
          {view.createTargets.length && actions.onCreate ? (
            <div className="cwu-browser-create">
              {view.showCreateTargetSelect && view.createTargets.length > 1 ? <select
                aria-label={labels.createTargetAriaLabel || '选择新 Session 的归属'}
                disabled={creating}
                onChange={(event) => setCreateTargetId(event.target.value)}
                value={createTargetId}
              >
                {view.createTargets.map((target) => <option key={target.id} value={target.id}>{target.label}</option>)}
              </select> : null}
              <button
                aria-label={labels.createAriaLabel || '新建 Session'}
                disabled={!createTargetId || creating}
                onClick={() => createSession()}
                title={labels.createLabel || '新建 Session'}
                type="button"
              >＋</button>
            </div>
          ) : null}
          {listOnly && actions.onCollapse ? (
            <button
              aria-label={labels.collapseList || '收起列表'}
              className="cwu-browser-collapse"
              onClick={actions.onCollapse}
              title={labels.collapseList || '收起列表'}
              type="button"
            >‹</button>
          ) : null}
        </header>

        <div className="cwu-browser-toolbar">
          {view.groupOptions.length > 1 ? (
            <div role="group" aria-label={labels.groupAriaLabel || 'Session 展示方式'}>
              {view.groupOptions.map((option) => (
                <button
                  className={view.groupMode === option.id ? 'is-active' : ''}
                  key={option.id}
                  onClick={() => actions.onGroupModeChange?.(option.id)}
                  type="button"
                >{option.label}</button>
              ))}
            </div>
          ) : <span className="cwu-browser-toolbar-label">{view.groupOptions[0]?.label || labels.listLabel || '当前 Session'}</span>}
          <div className="cwu-browser-toolbar-actions">
            {extensions.renderListHeaderActions?.({ browser: view, closeList: closeSessionList }) || null}
            <button
              aria-expanded={searchOpen}
              aria-label={labels.searchAriaLabel || '搜索 Sessions'}
              className={searchOpen ? 'is-active' : ''}
              onClick={() => { if (actions.onOpenSessionFinder) { if (drawerMode) closeSessionList(); actions.onOpenSessionFinder(); } else setSearchOpen((current) => !current); }}
              title={labels.searchAriaLabel || '搜索 Sessions'}
              type="button"
            ><svg aria-hidden="true" fill="none" viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></svg></button>
            {actions.onOpenHistory ? (
              <button onClick={actions.onOpenHistory} title={labels.history || '历史'} type="button">{labels.history || '历史'}</button>
            ) : null}
            {actions.onRefresh ? <button onClick={actions.onRefresh} type="button">{labels.refresh || '刷新'}</button> : null}
          </div>
        </div>

        {extensions.renderListFilters?.({ browser: view, searchQuery }) || null}

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
            {actions.onFullTextSearch ? (
              <button
                className="cwu-browser-full-text"
                disabled={!searchQuery.trim()}
                onClick={() => actions.onFullTextSearch(searchQuery.trim())}
                type="button"
              >{labels.fullTextSearch || '全文'}</button>
            ) : null}
          </label>
        ) : null}

        <div aria-busy={view.loading || view.loadingMore} className="cwu-browser-groups">
          {!view.loading && !groups.length ? (
            <div className="cwu-browser-list-empty">{searchQuery ? (labels.searchEmpty || '没有匹配的 Session。') : (labels.listEmpty || '还没有 Session，可从上方新建。')}</div>
          ) : groups.map((group) => {
            const favoritesGroup = group.id === 'favorites';
            const projectGroup = view.groupMode === 'context' && !favoritesGroup;
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
                const shared = session.accessKind === 'shared';
                const secondaryLabel = shared && !favoritesGroup
                  ? formatTime(session.updatedAt)
                  : session.secondaryLabel || (view.groupMode === 'context' && !favoritesGroup
                    ? formatTime(session.updatedAt)
                    : [session.contextLabel, formatTime(session.updatedAt)].filter(Boolean).join(' · '));
                return (
                <div
                  className={`cwu-browser-row ${session.id === view.selectedSessionId ? 'is-active' : ''} ${unread ? 'is-unread' : ''} ${session.reference ? 'is-reference-draggable' : ''}`}
                  draggable={Boolean(session.reference)}
                  key={session.id}
                  onDragStart={(event) => {
                    if (!session.reference || !setSessionReferenceDataTransfer(event.dataTransfer, session.reference)) {
                      event.preventDefault();
                    }
                  }}
                  title={session.reference ? (labels.dragReference || '拖到输入框以引用此 Session') : undefined}
                >
                  <button className="cwu-browser-row-main" onClick={() => actions.onSelect?.(session)} type="button">
                    <span
                      aria-hidden="true"
                      className={`cwu-browser-row-status cwu-status-${sessionStatusTone(session)}`}
                      title={session.statusLabel || undefined}
                    />
                    <span className="cwu-browser-row-copy">
                      <strong>{session.title}</strong>
                      <small>
                        {shared ? <svg
                          aria-label="与我共享，只读"
                          className="cwu-browser-row-shared"
                          fill="none"
                          role="img"
                          viewBox="0 0 24 24"
                        >
                          <circle cx="6" cy="12" r="2" />
                          <circle cx="17" cy="6" r="2" />
                          <circle cx="17" cy="18" r="2" />
                          <path d="m8 11 7-4M8 13l7 4" />
                        </svg> : null}
                        <span>{unread ? '新结果 · ' : ''}{secondaryLabel}</span>
                      </small>
                    </span>
                  </button>
                  {actions.onEnd && session.canEnd ? (
                    <details className="cwu-browser-row-menu">
                      <summary aria-label={`${labels.manage || '管理'}：${session.title}`} title={labels.manage || '管理'}>⋮</summary>
                      <div>
                        {actions.onArchive && session.canArchive ? (
                          <button disabled={archivingIds.has(session.id)} onClick={() => setArchived(session, !session.archived)} type="button">
                            {session.archived ? (labels.restore || '恢复') : (labels.archive || '归档')}
                          </button>
                        ) : null}
                        <button className="is-destructive" disabled={endingIds.has(session.id)} onClick={() => endSession(session)} type="button">
                          {endingIds.has(session.id) ? (labels.ending || '结束中…') : (labels.end || '结束')}
                        </button>
                      </div>
                    </details>
                  ) : actions.onArchive && session.canArchive ? (
                    <button
                      aria-label={`${session.archived ? (labels.restore || '恢复') : (labels.archive || '归档')}：${session.title}`}
                      className="cwu-browser-row-action cwu-browser-row-archive"
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
                  {actions.onFavorite && session.canFavorite ? (
                    <button
                      aria-label={`${session.favorited ? (labels.unfavorite || '取消置顶') : (labels.favorite || '置顶')}：${session.title}`}
                      aria-pressed={session.favorited}
                      className="cwu-browser-row-action cwu-browser-row-favorite"
                      disabled={favoritingIds.has(session.id)}
                      onClick={() => setFavorited(session, !session.favorited)}
                      title={session.favorited ? (labels.unfavorite || '取消置顶') : (labels.favorite || '置顶')}
                      type="button"
                    >{favoritingIds.has(session.id) ? '…' : session.favorited ? '★' : '☆'}</button>
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
  );

  if (listOnly) return <div className="cwu-session-list-standalone">{list}</div>;

  return (
    <div className={`cwu-browser ${listCollapsed ? 'is-list-collapsed' : ''}${browserDocumentPreview ? ' has-document-preview' : ''}${drawerMode ? ' is-drawer-mode' : ''}`}>
      {drawerMode && !listCollapsed && !browserDocumentPreview ? <button aria-label="关闭会话列表" className="cwu-browser-scrim" onClick={closeSessionList} tabIndex={-1} type="button"/> : null}
      <div className="cwu-browser-sidebar" role={drawerMode && !listCollapsed ? 'dialog' : undefined} aria-modal={drawerMode && !listCollapsed ? true : undefined} aria-label={labels.listAriaLabel || 'Session 列表'}>
      {list}

      {(isNarrow && detail) || actions.onToggleList ? <button
        aria-expanded={!listCollapsed}
        aria-label={listCollapsed ? (labels.expandList || '展开列表') : (labels.collapseList || '收起列表')}
        className="cwu-browser-list-toggle"
        ref={listToggleRef}
        disabled={Boolean(browserDocumentPreview)}
        inert={browserDocumentPreview ? true : undefined}
        onClick={toggleSessionList}
        title={listCollapsed ? (labels.expandList || '展开列表') : (labels.collapseList || '收起列表')}
        type="button"
      ><svg aria-hidden="true" viewBox="0 0 24 24" fill="none">{drawerMode && !listCollapsed ? <path d="m6 6 12 12M18 6 6 18"/> : <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M5.5 8h1M5.5 12h1M5.5 16h1"/></>}</svg></button> : null}
      </div>

      <section
        aria-hidden={browserDocumentPreview || drawerMode && !listCollapsed ? true : undefined}
        aria-label={labels.detailAriaLabel || 'Session 详情'}
        className="cwu-browser-detail"
        inert={browserDocumentPreview || drawerMode && !listCollapsed ? true : undefined}
      >
        {detail ? <SessionWorkspace key={detail.session?.sessionId || 'session-detail'} {...detail} uiStateStore={sessionUiState.current} documentPreview={null} /> : (
          <div className="cwu-browser-detail-empty">
            <span>{labels.detailEyebrow || 'Session 详情'}</span>
            <h2>{labels.detailEmptyTitle || '从左侧选择一个 Session'}</h2>
            <p>{labels.detailEmptyBody || '这里会展示完整对话、执行过程和后续输入框。'}</p>
          </div>
        )}
      </section>
      <SessionDocumentPreview
        actions={detail?.actions}
        documentPreview={browserDocumentPreview}
        labels={detail?.labels}
      />
    </div>
  );
}

export function SessionList(props) {
  return <SessionBrowser {...props} detail={null} listOnly />;
}

function SessionDocumentPreview({ actions = {}, documentPreview, labels = {} }) {
  if (!documentPreview) return null;
  return (
    <DocumentPreview
      documentResourceUrl={actions.documentResourceUrl}
      file={documentPreview}
      onClose={actions.onCloseDocument}
      onDownload={actions.onDownloadDocument}
      onEdit={actions.onEditDocument}
      onOpenExternal={actions.onOpenDocumentExternal}
      onOpenLink={actions.onOpenLink}
      onReveal={actions.onRevealDocument}
      onRevealLink={actions.onRevealLink}
      onSave={actions.onSaveDocument}
      revealLabel={labels.revealFile}
    />
  );
}

function CommentaryGroup({ children, initiallyOpen = false, messageCount }) {
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <details
      className="cwu-commentary-group"
      onToggle={(event) => setOpen(event.currentTarget.open)}
      open={open}
    >
      <summary><span>过程 · {messageCount} 条</span><small /></summary>
      <div className="cwu-commentary-group-body">{children}</div>
    </details>
  );
}

export function SessionWorkspace({
  session,
  compactComposer = false,
  composerPresentation = 'default',
  technicalDetailsPresentation = 'default',
  uiStateStore = null,
  attachmentPolicy = {},
  documentPreview = null,
  actions = {},
  extensions = {},
  features = {},
  labels = {},
}) {
  const view = useMemo(() => {
    const normalized = normalizeSessionViewModel(session);
    if (!compactComposer) return normalized;
    const commentary = normalized.messages.filter((message) => message.phase === 'commentary');
    return { ...normalized, messages: normalized.messages.filter((message) => message.phase !== 'commentary'),
      technicalItems: [...commentary.map((message) => ({ ...message, type: 'assistant', title: 'Codex', text: message.content })), ...normalized.technicalItems]
        .sort((a, b) => { const left = Date.parse(a.startedAt || a.createdAt), right = Date.parse(b.startedAt || b.createdAt); return Number.isFinite(left) && Number.isFinite(right) ? left - right : 0; }) };
  }, [session, compactComposer]);
  const messageEntries = useMemo(() => groupSessionMessages(view.messages), [view.messages]);
  const latestCommentaryGroupId = [...messageEntries]
    .reverse()
    .find((entry) => entry.kind === 'commentary-group')?.id || null;
  const enabledFeatures = useMemo(() => normalizeSessionFeatures(features), [features]);
  const uploadPolicy = useMemo(() => normalizeAttachmentPolicy(attachmentPolicy), [attachmentPolicy]);
  const transcriptRef = useRef(null);
  const composerRef = useRef(null);
  const followLatestRef = useRef(true);
  const submitFollowRef = useRef(false);
  const transcriptScrollTopRef = useRef(0);
  const transcriptTouchYRef = useRef(null);
  const messageActivityRef = useRef({ sessionId: view.sessionId, key: '' });
  const [composerOptionsOpen, setComposerOptionsOpen] = useState(false);
  const [mobileSubmitMode, setMobileSubmitMode] = useState('steer');
  const splitSendComposer = compactComposer && composerPresentation === 'split-send';
  const [sendModeOpen, setSendModeOpen] = useState(false);
  const sendModeId = useId();
  const sendModeGroupRef = useRef(null);
  const sendModeButtonRef = useRef(null);
  const sendModeMenuRef = useRef(null);
  const composerOptionsWidthProbeRef = useRef(null);
  const [composerOptionsIconOnly, setComposerOptionsIconOnly] = useState(false);
  const executionOptionsRequestRef = useRef(null);
  const [executionOptionsState, setExecutionOptionsState] = useState({ loading: false, error: '' });
  const composerOptionsRef = useRef(null);
  const composerOptionsButtonRef = useRef(null);
  const composerFooterRef = useRef(null);
  const composerActionsRef = useRef(null);
  const composerAttachmentRef = useRef(null);
  const composerWidthProbeRef = useRef(null);
  const [inlineExecutionControls, setInlineExecutionControls] = useState(false);
  const cachedUi = uiStateStore?.get(view.sessionId);
  const [draft, setDraft] = useState(cachedUi?.draft ?? view.draft);
  const [processOpenByTurn, setProcessOpenByTurn] = useState(cachedUi?.processOpenByTurn || {});
  const [detailTabByTurn, setDetailTabByTurn] = useState(cachedUi?.detailTabByTurn || {});
  const [attachments, setAttachments] = useState(cachedUi?.attachments || []);
  const [references, setReferences] = useState(cachedUi?.references || []);
  const [referenceMention, setReferenceMention] = useState(null);
  const [referenceOptions, setReferenceOptions] = useState([]);
  const [referenceActiveIndex, setReferenceActiveIndex] = useState(0);
  const [referenceSearchState, setReferenceSearchState] = useState({ loading: false, error: '' });
  const [attachmentUploadState, setAttachmentUploadState] = useState({ status: 'idle', error: '' });
  const [attachmentDragActive, setAttachmentDragActive] = useState(false);
  const [attachmentDragKind, setAttachmentDragKind] = useState('files');
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  const [hasNewMessagesBelow, setHasNewMessagesBelow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [composerReadOnly, setComposerReadOnly] = useState(false);
  const [subagentsOpen, setSubagentsOpen] = useState(false);
  const [deletingQueuedIds, setDeletingQueuedIds] = useState(() => new Set());
  const [executionSettingsOpen, setExecutionSettingsOpen] = useState(false);
  const [executionSettingsSaving, setExecutionSettingsSaving] = useState(false);
  const [executionPopoverPosition, setExecutionPopoverPosition] = useState({ left: 12, top: 12, side: 'above' });
  const executionSettingsButtonRef = useRef(null);
  const executionSettingsPopoverRef = useRef(null);
  const executionSettingsSaveRef = useRef(null);
  const attachmentInteractionRef = useRef({ composerDisabled: false, uploading: false, attachmentCount: 0 });
  const running = view.status === 'running';
  const uploading = attachments.some((attachment) => attachment.status === 'uploading');
  const readyAttachments = attachments.filter((attachment) => attachment.status !== 'error' && attachment.status !== 'uploading');
  const composerDisabled = view.composerDisabled || submitting;
  attachmentInteractionRef.current = {
    composerDisabled,
    uploading,
    attachmentCount: attachments.length,
  };
  const executionSettingsLocked = ['running', 'waiting'].includes(view.status);
  const executionControlsDisabled = composerDisabled
    || executionSettingsLocked
    || executionSettingsSaving
    || !actions.onExecutionProfileChange;
  const selectedExecutionModel = view.models.find((model) => model.id === view.executionProfile.model) || null;
  const executionEfforts = selectedExecutionModel?.reasoningEfforts?.length
    ? selectedExecutionModel.reasoningEfforts
    : ['low', 'medium', 'high', 'xhigh'];
  const fastTier = selectedExecutionModel?.serviceTiers.find((tier) => tier.id === 'priority') || null;
  const executionModelLabel = selectedExecutionModel?.label || view.executionProfile.model || '默认模型';
  const executionAccessLabel = view.accessModes.find((mode) => mode.id === view.executionProfile.accessMode)?.label
    || view.executionProfile.accessMode;
  const composer = sessionComposerPresentation({
    running,
    submitting,
    canSteer: enabledFeatures.steer,
    canQueue: enabledFeatures.queuedTurns,
    activityKind: view.activityKind,
  });
  const canSubmit = Boolean((draft.trim() || readyAttachments.length)
    && !composerDisabled
    && !composerReadOnly
    && !uploading
    && actions.onSubmit
    && composer.primaryMode);
  const compactInputMode = compactComposer && running && mobileSubmitMode === 'queue' && (!splitSendComposer || composer.showSecondary) ? 'queue' : composer.primaryMode;
  const compactInputLabel = compactInputMode === 'queue' ? '下一轮' : composer.primaryLabel;
  useEffect(() => {
    if (inlineExecutionControls && composerOptionsOpen) setComposerOptionsOpen(false);
  }, [inlineExecutionControls, composerOptionsOpen]);
  useEffect(() => {
    if (!compactComposer) return;
    const footer = composerFooterRef.current;
    const probe = composerWidthProbeRef.current;
    const actionRow = composerActionsRef.current;
    if (!footer || !probe || !actionRow) return;
    function measure() {
      const controls = [...actionRow.children].filter(control => !splitSendComposer || control.getBoundingClientRect().width > 0);
      const actionGap = Number.parseFloat(getComputedStyle(actionRow).columnGap) || 0;
      const footerGap = Number.parseFloat(getComputedStyle(footer).columnGap) || 0;
      const metaGap = Number.parseFloat(getComputedStyle(footer.firstElementChild).columnGap) || 0;
      const actionWidth = controls.reduce((width, control) => width + control.getBoundingClientRect().width, 0) + actionGap * Math.max(0, controls.length - 1);
      const attachmentWidth = composerAttachmentRef.current?.getBoundingClientRect().width || 0;
      const fixedWidth = attachmentWidth + (attachmentWidth ? metaGap : 0) + actionWidth + footerGap;
      const requiredWidth = probe.getBoundingClientRect().width + fixedWidth;
      setInlineExecutionControls(previous => footer.clientWidth >= requiredWidth + (previous ? 0 : 12));
      if (splitSendComposer) setComposerOptionsIconOnly(footer.clientWidth < (composerOptionsWidthProbeRef.current?.getBoundingClientRect().width || 0) + fixedWidth);
    }
    measure();
    const observer = new ResizeObserver(measure);
    for (const element of [footer, probe, composerOptionsWidthProbeRef.current, ...actionRow.children, composerAttachmentRef.current].filter(Boolean)) observer.observe(element);
    return () => observer.disconnect();
  }, [compactComposer, splitSendComposer, view.sessionId, running, submitting, mobileSubmitMode, composer.showSecondary, executionModelLabel, enabledFeatures.attachments]);
  useEffect(() => {
    if (!composerOptionsOpen) return;
    const panel = composerOptionsRef.current;
    panel?.focus();
    function keydown(event) {
      if (event.key === 'Escape') setComposerOptionsOpen(false);
      if (event.key !== 'Tab') return;
      const controls = [...panel.querySelectorAll('button:not(:disabled),select:not(:disabled)')];
      const first = controls[0], last = controls.at(-1);
      if (!first) { event.preventDefault(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || document.activeElement === panel)) { event.preventDefault(); first.focus(); }
    }
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); (composerOptionsButtonRef.current || composerFooterRef.current?.querySelector('select:not(:disabled),button:not(:disabled)'))?.focus(); };
  }, [composerOptionsOpen]);
  useEffect(() => {
    executionOptionsRequestRef.current = null;
    setExecutionOptionsState({ loading: false, error: '' });
    setSendModeOpen(false);
  }, [view.sessionId]);
  useEffect(() => {
    if (!running || !composer.showSecondary || !splitSendComposer) setSendModeOpen(false);
  }, [running, composer.showSecondary, splitSendComposer]);
  useEffect(() => {
    if (!sendModeOpen) return;
    const menu = sendModeMenuRef.current;
    menu?.querySelector('[aria-checked="true"]')?.focus();
    function closeOutside(event) {
      if (!sendModeGroupRef.current?.contains(event.target)) setSendModeOpen(false);
    }
    function closeOnEscape(event) {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setSendModeOpen(false);
      sendModeButtonRef.current?.focus();
    }
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [sendModeOpen]);

  function loadExecutionOptions() {
    if (!splitSendComposer || !actions.onLoadExecutionOptions) return;
    const current = executionOptionsRequestRef.current;
    if (current?.sessionId === view.sessionId && (current.loading || current.loaded)) return;
    const request = { sessionId: view.sessionId, loading: true, loaded: false };
    executionOptionsRequestRef.current = request;
    setExecutionOptionsState({ loading: true, error: '' });
    Promise.resolve().then(() => actions.onLoadExecutionOptions()).then(() => {
      request.loaded = true;
      if (executionOptionsRequestRef.current === request) setExecutionOptionsState({ loading: false, error: '' });
    }).catch(error => {
      if (executionOptionsRequestRef.current === request) setExecutionOptionsState({ loading: false, error: error?.message || '输入选项加载失败。' });
    }).finally(() => { request.loading = false; });
  }

  function chooseSendMode(mode) {
    setMobileSubmitMode(mode);
    setSendModeOpen(false);
    sendModeButtonRef.current?.focus();
  }

  function handleSendModeKeyDown(event) {
    if (event.key === 'Tab') { event.preventDefault(); setSendModeOpen(false); sendModeButtonRef.current?.focus(); return; }
    const items = [...(sendModeMenuRef.current?.querySelectorAll('[role="menuitemradio"]') || [])];
    const index = items.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1
      : event.key === 'ArrowDown' ? (index + 1) % items.length
      : event.key === 'ArrowUp' ? (index - 1 + items.length) % items.length : null;
    if (next == null) return;
    event.preventDefault();
    items[next]?.focus();
  }

  function renderComposerOptionsButton({ probe = false } = {}) {
    const iconOnly = splitSendComposer && composerOptionsIconOnly && !probe;
    return <button aria-label={splitSendComposer ? `输入选项 · ${executionModelLabel}` : '输入选项'} title={executionModelLabel}
      aria-expanded={composerOptionsOpen} className={`cwu-composer-options-button${iconOnly ? ' is-icon-only' : ''}`}
      ref={probe ? null : composerOptionsButtonRef} type="button" onClick={() => { setComposerOptionsOpen(true); loadExecutionOptions(); }}>
      {iconOnly ? <svg className="cwu-composer-brain" aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 5a3 3 0 0 0-5.8-1A4 4 0 0 0 3 10a4 4 0 0 0 1 7.5A4 4 0 0 0 12 19V5Zm0 0a3 3 0 0 1 5.8-1A4 4 0 0 1 21 10a4 4 0 0 1-1 7.5A4 4 0 0 1 12 19M7 4v4M4 11h3l2 2M5 17h3M17 4v4M20 11h-3l-2 2M19 17h-3"/></svg>
        : <><span>{executionModelLabel || '输入选项'}</span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="m7 10 5 5 5-5"/></svg></>}
    </button>;
  }

  function renderExecutionOptionsStatus() {
    if (!splitSendComposer || (!executionOptionsState.loading && !executionOptionsState.error)) return null;
    return <div className="cwu-execution-options-status" role={executionOptionsState.error ? 'alert' : 'status'}>
      {executionOptionsState.loading ? '正在加载输入选项…' : <>{executionOptionsState.error}<button type="button" onClick={loadExecutionOptions}>重试</button></>}
    </div>;
  }
  const latestMessage = view.messages.at(-1);
  const latestMessageActivityKey = (latestMessage
    ? `${latestMessage.id}:${latestMessage.content.length}:${latestMessage.content.slice(-32)}`
    : '') + view.technicalItems.map(item => `|${item.id}:${String(item.text || '').length}:${String(item.output || '').length}:${String(item.detail || '').length}`).join('');
  const technicalByTurn = new Map();
  const technicalMetadataByTurn = new Map(view.turnMetadata.map((turn) => [turn.turnKey, turn]));
  const lastMessageByTurn = new Map();
  const technicalDetailsAvailable = new Set(view.technicalDetailsAvailable);
  for (const item of view.technicalItems) {
    const key = item.turnKey || item.turnId || 'unassigned';
    const values = technicalByTurn.get(key) || [];
    values.push(item);
    technicalByTurn.set(key, values);
  }
  for (const message of view.messages) {
    const key = message.turnKey || message.turnId;
    if (key) lastMessageByTurn.set(key, message.id);
  }

  useEffect(() => {
    const restored = uiStateStore?.get(view.sessionId);
    followLatestRef.current = !restored?.awayFromLatest;
    submitFollowRef.current = false;
    transcriptScrollTopRef.current = restored?.scrollTop || 0;
    if (restored?.awayFromLatest) requestAnimationFrame(() => { if (transcriptRef.current) transcriptRef.current.scrollTop = restored.scrollTop; });
    transcriptTouchYRef.current = null;
    setDraft(restored?.draft ?? view.draft);
    setAttachments(restored?.attachments || []);
    setReferences(restored?.references || []);
    setReferenceMention(null);
    setReferenceOptions([]);
    setReferenceActiveIndex(0);
    setReferenceSearchState({ loading: false, error: '' });
    setAttachmentUploadState({ status: 'idle', error: '' });
    setAttachmentDragActive(false);
    setAttachmentDragKind('files');
    setAwayFromLatest(Boolean(restored?.awayFromLatest));
    setHasNewMessagesBelow(false);
    setExecutionSettingsOpen(false);
    setExecutionSettingsSaving(false);
    executionSettingsSaveRef.current = null;
    messageActivityRef.current = { sessionId: view.sessionId, key: latestMessageActivityKey };
    const focusFrame = view.draft
      ? requestAnimationFrame(() => {
          const target = composerRef.current;
          if (!target) return;
          target.focus();
          target.setSelectionRange(view.draft.length, view.draft.length);
        })
      : null;
    return () => {
      if (focusFrame != null) cancelAnimationFrame(focusFrame);
    };
  }, [view.sessionId]);

  const uiSnapshot = useRef(null);
  uiSnapshot.current = { draft, attachments, references, processOpenByTurn, detailTabByTurn, awayFromLatest };
  useEffect(() => {
    if (!uiStateStore) return undefined;
    const save = () => {
      uiStateStore.set(view.sessionId, { ...uiSnapshot.current, scrollTop: transcriptRef.current?.scrollTop || 0 });
    };
    window.addEventListener('pagehide', save);
    document.addEventListener('visibilitychange', save);
    return () => { save(); window.removeEventListener('pagehide', save); document.removeEventListener('visibilitychange', save); };
  }, [view.sessionId, uiStateStore]);

  useEffect(() => {
    if (!executionSettingsOpen) return undefined;
    const positionPopover = () => {
      const target = executionSettingsButtonRef.current;
      const popover = executionSettingsPopoverRef.current;
      if (!target || !popover) return;
      const edge = 12;
      const gap = 8;
      const targetRect = target.getBoundingClientRect();
      const popoverRect = popover.getBoundingClientRect();
      const left = Math.min(
        Math.max(edge, targetRect.left),
        Math.max(edge, window.innerWidth - popoverRect.width - edge),
      );
      const above = targetRect.top - popoverRect.height - gap;
      const placeBelow = above < edge;
      setExecutionPopoverPosition({
        left,
        top: placeBelow
          ? Math.min(window.innerHeight - popoverRect.height - edge, targetRect.bottom + gap)
          : above,
        side: placeBelow ? 'below' : 'above',
      });
    };
    const closeOutside = (event) => {
      if (executionSettingsButtonRef.current?.contains(event.target)
        || executionSettingsPopoverRef.current?.contains(event.target)) return;
      setExecutionSettingsOpen(false);
    };
    const closeOnEscape = (event) => {
      if (event.key !== 'Escape') return;
      setExecutionSettingsOpen(false);
      executionSettingsButtonRef.current?.focus();
    };
    positionPopover();
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', positionPopover, true);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
      window.removeEventListener('resize', positionPopover);
      window.removeEventListener('scroll', positionPopover, true);
    };
  }, [executionSettingsOpen, view.sessionId]);

  useEffect(() => {
    if (!executionSettingsLocked) setExecutionSettingsOpen(false);
  }, [executionSettingsLocked]);

  useEffect(() => {
    if (!referenceMention || !actions.onSearchSessionReferences) {
      setReferenceOptions([]);
      setReferenceSearchState({ loading: false, error: '' });
      return undefined;
    }
    let cancelled = false;
    const timeout = setTimeout(async () => {
      setReferenceSearchState({ loading: true, error: '' });
      try {
        const result = await actions.onSearchSessionReferences({
          query: referenceMention.query,
          cursor: null,
          sourceSessionId: view.sessionId,
        });
        if (cancelled) return;
        const values = Array.isArray(result) ? result : result?.references || result?.items;
        const selectedKeys = new Set(references.map(sessionReferenceKey));
        const options = normalizeSessionReferences(values, { maximum: MAX_SESSION_REFERENCES })
          .filter((reference) => reference.threadId !== (view.threadId || view.sessionId) && !selectedKeys.has(sessionReferenceKey(reference)));
        setReferenceOptions(options);
        setReferenceActiveIndex(0);
        setReferenceSearchState({ loading: false, error: '' });
      } catch (error) {
        if (cancelled) return;
        setReferenceOptions([]);
        setReferenceSearchState({ loading: false, error: error?.message || 'Session 搜索失败。' });
      }
    }, 120);
    return () => {
      cancelled = true;
      clearTimeout(timeout);
    };
  }, [actions.onSearchSessionReferences, referenceMention?.query, references, view.sessionId]);

  useEffect(() => {
    const followAfterViewportChange = () => {
      if (!submitFollowRef.current) return;
      requestAnimationFrame(() => {
        const target = transcriptRef.current;
        if (!target) return;
        target.scrollTop = target.scrollHeight;
        transcriptScrollTopRef.current = target.scrollTop;
        setAwayFromLatest(false);
        setHasNewMessagesBelow(false);
      });
    };
    window.addEventListener('resize', followAfterViewportChange);
    window.visualViewport?.addEventListener('resize', followAfterViewportChange);
    return () => {
      window.removeEventListener('resize', followAfterViewportChange);
      window.visualViewport?.removeEventListener('resize', followAfterViewportChange);
    };
  }, [view.sessionId]);

  useEffect(() => {
    const previousActivity = messageActivityRef.current;
    const hasNewActivity = previousActivity.sessionId === view.sessionId
      && Boolean(previousActivity.key)
      && previousActivity.key !== latestMessageActivityKey;
    messageActivityRef.current = { sessionId: view.sessionId, key: latestMessageActivityKey };
    const target = transcriptRef.current;
    if (target && followLatestRef.current) {
      target.scrollTop = target.scrollHeight;
      transcriptScrollTopRef.current = target.scrollTop;
      setAwayFromLatest(false);
      setHasNewMessagesBelow(false);
    } else if (hasNewActivity) {
      setHasNewMessagesBelow(true);
    }
  }, [view.sessionId, latestMessageActivityKey, view.status]);

  useEffect(() => {
    const target = composerRef.current;
    if (!target) return;
    target.style.height = 'auto';
    target.style.height = `${Math.min(target.scrollHeight, 220)}px`;
  }, [draft]);

  function followLatest() {
    followLatestRef.current = true;
    setAwayFromLatest(false);
    setHasNewMessagesBelow(false);
    requestAnimationFrame(() => {
      const target = transcriptRef.current;
      if (target) {
        target.scrollTop = target.scrollHeight;
        transcriptScrollTopRef.current = target.scrollTop;
      }
    });
  }

  function updateFollowState(event) {
    const target = event.currentTarget;
    const previousScrollTop = transcriptScrollTopRef.current;
    const scrollingUp = target.scrollTop < previousScrollTop - 1;
    transcriptScrollTopRef.current = target.scrollTop;
    if (scrollingUp) {
      pauseLatestFollow();
      return;
    }
    const atLatest = !sessionTranscriptAwayFromLatest(target, 24);
    if (atLatest) {
      followLatestRef.current = true;
      setAwayFromLatest(false);
      setHasNewMessagesBelow(false);
      return;
    }
    if (!followLatestRef.current || sessionTranscriptAwayFromLatest(target)) {
      followLatestRef.current = false;
      submitFollowRef.current = false;
      setAwayFromLatest(true);
    }
  }

  function stopSubmitFollow() {
    submitFollowRef.current = false;
  }

  function pauseLatestFollow() {
    followLatestRef.current = false;
    submitFollowRef.current = false;
    setAwayFromLatest(true);
  }

  function handleTranscriptWheel(event) {
    stopSubmitFollow();
    if (event.deltaY < 0) pauseLatestFollow();
  }

  function handleTranscriptTouchStart(event) {
    stopSubmitFollow();
    transcriptTouchYRef.current = event.touches?.[0]?.clientY ?? null;
  }

  function handleTranscriptTouchMove(event) {
    const nextY = event.touches?.[0]?.clientY ?? null;
    const previousY = transcriptTouchYRef.current;
    if (nextY != null && previousY != null && nextY > previousY + 2) pauseLatestFollow();
    transcriptTouchYRef.current = nextY;
  }

  function handleTranscriptTouchEnd() {
    transcriptTouchYRef.current = null;
  }

  function scrollToLatest() {
    const target = transcriptRef.current;
    if (!target) return;
    followLatestRef.current = true;
    setHasNewMessagesBelow(false);
    target.scrollTo({ top: target.scrollHeight, behavior: 'smooth' });
    transcriptScrollTopRef.current = target.scrollHeight;
  }

  function updateReferenceMention(value, selectionStart) {
    if (!actions.onSearchSessionReferences || references.length >= MAX_SESSION_REFERENCES) {
      setReferenceMention(null);
      return;
    }
    setReferenceMention(composerSessionMention(value, selectionStart));
  }

  function addSessionReference(reference) {
    if (!reference || reference.threadId === (view.threadId || view.sessionId)) {
      setReferenceSearchState({ loading: false, error: '不能引用当前 Session。' });
      return false;
    }
    const next = normalizeSessionReferences([...references, reference]);
    if (next.length === references.length) {
      const duplicate = references.some((item) => sessionReferenceKey(item) === sessionReferenceKey(reference));
      setReferenceSearchState({
        loading: false,
        error: duplicate ? '这个 Session 已经引用。' : `每轮最多引用 ${MAX_SESSION_REFERENCES} 个 Session。`,
      });
      return false;
    }
    setReferences(next);
    setReferenceSearchState({ loading: false, error: '' });
    return true;
  }

  function selectSessionReference(reference) {
    if (!referenceMention || !addSessionReference(reference)) return;
    const nextDraft = removeComposerSessionMention(draft, referenceMention);
    setDraft(nextDraft);
    actions.onDraftChange?.(nextDraft);
    setReferenceMention(null);
    setReferenceOptions([]);
    requestAnimationFrame(() => {
      const target = composerRef.current;
      if (!target) return;
      target.focus();
      target.setSelectionRange(referenceMention.start, referenceMention.start);
    });
  }

  async function resolveSubmittedReferences(submittedReferences) {
    if (!submittedReferences.length) return [];
    if (!actions.onResolveSessionReferences) {
      setReferences(submittedReferences.map((reference) => ({ ...reference, unavailable: true })));
      setReferenceSearchState({ loading: false, error: '当前宿主无法验证这些 Session 引用。' });
      return null;
    }
    let result;
    try {
      result = await actions.onResolveSessionReferences({
        references: submittedReferences,
        sourceSessionId: view.sessionId,
      });
    } catch (error) {
      setReferenceSearchState({ loading: false, error: error?.message || 'Session 引用验证失败。' });
      return null;
    }
    const resolved = normalizeSessionReferences(Array.isArray(result) ? result : result?.references);
    const resolvedByKey = new Map(resolved.map((reference) => [sessionReferenceKey(reference), reference]));
    const projected = submittedReferences.map((reference) => (
      resolvedByKey.get(sessionReferenceKey(reference)) || { ...reference, unavailable: true }
    ));
    if (projected.some((reference) => reference.unavailable)) {
      setReferences(projected);
      setReferenceSearchState({ loading: false, error: '有 Session 引用已不可用，请移除后再发送。' });
      return null;
    }
    return projected;
  }

  async function submit(mode = 'turn') {
    const prompt = draft.trim();
    if ((!prompt && !readyAttachments.length) || submitting || uploading || !actions.onSubmit) return;
    const submittedDraft = draft;
    const submittedAttachments = readyAttachments;
    const submittedReferences = references;
    setSubmitting(true);
    const resolvedReferences = await resolveSubmittedReferences(submittedReferences);
    if (resolvedReferences == null) {
      setSubmitting(false);
      return;
    }
    submitFollowRef.current = true;
    followLatest();
    setDraft('');
    setAttachments((current) => current.filter((attachment) => attachment.status === 'error'));
    setReferences([]);
    setReferenceMention(null);
    setReferenceOptions([]);
    setReferenceSearchState({ loading: false, error: '' });
    setAttachmentUploadState({ status: 'idle', error: '' });
    try {
      await actions.onSubmit({
        prompt,
        mode,
        attachments: submittedAttachments,
        references: resolvedReferences,
      });
    } catch (error) {
      setDraft(submittedDraft);
      setAttachments((current) => [...submittedAttachments, ...current].slice(0, uploadPolicy.maxCount));
      setReferences(submittedReferences);
      actions.onError?.(error);
    } finally {
      setSubmitting(false);
    }
  }

  async function uploadFiles(fileList) {
    const availableSlots = Math.max(0, uploadPolicy.maxCount - attachments.length);
    const candidates = [...(fileList || [])].slice(0, availableSlots);
    if (!availableSlots && (fileList?.length || 0)) {
      const errors = [`单次最多 ${uploadPolicy.maxCount} 个附件。`];
      setAttachmentUploadState({ status: 'error', error: errors[0] });
      return errors;
    }
    const files = candidates.filter((file) => (
      file.size <= uploadPolicy.maxBytes && fileMatchesAccept(file, uploadPolicy.accept)
    ));
    if (!actions.onUploadAttachments) return [];
    if (!files.length) {
      if (candidates.length) {
        setAttachmentUploadState({ status: 'error', error: '附件不符合格式或大小限制。' });
        return ['附件不符合格式或大小限制。'];
      }
      return [];
    }
    setAttachmentUploadState({ status: 'idle', error: '' });
    const errors = candidates.length > files.length
      ? ['部分附件不符合格式或大小限制。']
      : [];
    const pending = files.map((file) => ({
      ...normalizeSessionAttachment({
        id: temporaryAttachmentId(),
        name: file.name,
        mimeType: file.type,
        size: file.size,
        status: 'uploading',
        progress: 0,
      }),
      file,
    }));
    setAttachments((current) => [...current, ...pending].slice(0, uploadPolicy.maxCount));
    for (const placeholder of pending) {
      try {
        const uploaded = (await actions.onUploadAttachments([placeholder.file], {
          onProgress: (progress) => {
            const nextProgress = attachmentProgressPercent(progress);
            setAttachments((current) => current.map((attachment) => (
              attachment.id === placeholder.id
                ? { ...attachment, progress: nextProgress }
                : attachment
            )));
          },
        })) || [];
        if (!uploaded.length) throw new Error(`${placeholder.name} 上传后没有返回附件`);
        setAttachments((current) => current.flatMap((attachment) => (
          attachment.id === placeholder.id
            ? uploaded.map((item, index) => ({
                ...item,
                id: String(item?.id || `${placeholder.id}-${index}`),
                name: String(item?.name || placeholder.name),
                mimeType: String(item?.mimeType || placeholder.mimeType),
                size: Number.isFinite(Number(item?.size)) ? Number(item.size) : placeholder.size,
                kind: item?.kind || placeholder.kind,
                status: 'ready',
                progress: 100,
              }))
            : [attachment]
        )).slice(0, uploadPolicy.maxCount));
      } catch (error) {
        const message = error?.message || `${placeholder.name} 上传失败`;
        errors.push(message);
        setAttachments((current) => current.map((attachment) => (
          attachment.id === placeholder.id
            ? { ...attachment, status: 'error', error: message, progress: 0 }
            : attachment
        )));
      }
    }
    setAttachmentUploadState({
      status: errors.length ? 'error' : 'idle',
      error: errors[0] || '',
    });
    return errors;
  }

  async function retryAttachment(attachment) {
    if (!attachment.file || attachment.status !== 'error') return;
    setAttachmentUploadState({ status: 'idle', error: '' });
    setAttachments((current) => current.map((item) => (
      item.id === attachment.id ? { ...item, status: 'uploading', error: '', progress: 0 } : item
    )));
    try {
      const uploaded = (await actions.onUploadAttachments([attachment.file], {
        onProgress: (progress) => {
          const nextProgress = attachmentProgressPercent(progress);
          setAttachments((current) => current.map((item) => (
            item.id === attachment.id ? { ...item, progress: nextProgress } : item
          )));
        },
      })) || [];
      if (!uploaded.length) throw new Error(`${attachment.name} 上传后没有返回附件`);
      setAttachments((current) => current.flatMap((item) => (
        item.id === attachment.id
          ? uploaded.map((uploadedItem, index) => ({
              ...uploadedItem,
              id: String(uploadedItem?.id || `${attachment.id}-${index}`),
              name: String(uploadedItem?.name || attachment.name),
              mimeType: String(uploadedItem?.mimeType || attachment.mimeType),
              size: Number.isFinite(Number(uploadedItem?.size)) ? Number(uploadedItem.size) : attachment.size,
              kind: uploadedItem?.kind || attachment.kind,
              status: 'ready',
              progress: 100,
            }))
          : [item]
      )));
    } catch (error) {
      const message = error?.message || `${attachment.name} 上传失败`;
      setAttachmentUploadState({ status: 'error', error: message });
      setAttachments((current) => current.map((item) => (
        item.id === attachment.id ? { ...item, status: 'error', error: message, progress: 0 } : item
      )));
    }
  }

  async function uploadAttachments(event) {
    // FileList is live: clearing the input also empties the same object in Chromium.
    // Snapshot it first so the upload still receives the files the user selected.
    const files = [...(event.target.files || [])];
    event.target.value = '';
    await uploadFiles(files);
  }

  function handleAttachmentDrag(event) {
    const hasSessionReference = dataTransferHasSessionReference(event.dataTransfer);
    const transferHasFiles = dataTransferHasFiles(event.dataTransfer);
    if (hasSessionReference) {
      event.preventDefault();
      const interaction = attachmentInteractionRef.current;
      if (interaction.composerDisabled || interaction.uploading || !actions.onResolveSessionReferences) return;
      event.dataTransfer.dropEffect = transferHasFiles ? 'none' : 'link';
      setAttachmentDragKind(transferHasFiles ? 'invalid-reference-mix' : 'session-reference');
      setAttachmentDragActive(true);
      return;
    }
    if (!transferHasFiles
      || (!actions.onUploadAttachments && !actions.onResolveDroppedDirectories)) return;
    event.preventDefault();
    const interaction = attachmentInteractionRef.current;
    if (interaction.composerDisabled || interaction.uploading) return;
    const payload = composerDropPayload(event.dataTransfer);
    const hasDirectories = payload.directories.length > 0;
    const hasFiles = payload.files.length > 0;
    const opaqueFilePreview = !hasDirectories && !hasFiles;
    if (!hasDirectories && ((!hasFiles && !opaqueFilePreview) || interaction.attachmentCount >= uploadPolicy.maxCount)) return;
    event.dataTransfer.dropEffect = hasDirectories ? 'link' : 'copy';
    setAttachmentDragKind(hasDirectories ? hasFiles ? 'mixed' : 'directories' : 'files');
    setAttachmentDragActive(true);
  }

  function handleAttachmentDragLeave(event) {
    if (!attachmentDragLeavesTarget(event)) return;
    setAttachmentDragActive(false);
    setAttachmentDragKind('files');
  }

  async function handleAttachmentDrop(event) {
    const hasSessionReference = dataTransferHasSessionReference(event.dataTransfer);
    const transferHasFiles = dataTransferHasFiles(event.dataTransfer);
    if (hasSessionReference) {
      event.preventDefault();
      setAttachmentDragActive(false);
      setAttachmentDragKind('files');
      if (transferHasFiles) {
        setReferenceSearchState({ loading: false, error: 'Session 引用不能与文件在同一次拖放中混合。' });
        return;
      }
      if (!actions.onResolveSessionReferences) {
        setReferenceSearchState({ loading: false, error: '当前宿主不支持 Session 引用。' });
        return;
      }
      const reference = sessionReferenceFromDataTransfer(event.dataTransfer);
      if (!reference) {
        setReferenceSearchState({ loading: false, error: '无法读取这个 Session 引用。' });
        return;
      }
      addSessionReference(reference);
      return;
    }
    if (!transferHasFiles
      || (!actions.onUploadAttachments && !actions.onResolveDroppedDirectories)) return;
    event.preventDefault();
    setAttachmentDragActive(false);
    setAttachmentDragKind('files');
    const interaction = attachmentInteractionRef.current;
    if (interaction.composerDisabled || interaction.uploading) return;
    const { directories, files } = composerDropPayload(event.dataTransfer);
    const errors = files.length ? await uploadFiles(files) : [];
    if (directories.length) {
      if (!actions.onResolveDroppedDirectories) {
        errors.push(labels.directoryDropUnsupported || '当前宿主不支持引用文件夹。');
      } else {
        try {
          const result = await actions.onResolveDroppedDirectories({ directories });
          const references = Array.isArray(result) ? result : result?.references;
          const resources = Array.isArray(result?.resources) ? result.resources : [];
          const availableResourceSlots = Math.max(0, uploadPolicy.maxCount - attachmentInteractionRef.current.attachmentCount);
          const acceptedResources = resources.slice(0, availableResourceSlots).map((resource, index) => ({
            ...normalizeSessionAttachment(resource, `directory-${index}`),
            status: 'ready',
            progress: 100,
          }));
          if (acceptedResources.length) {
            setAttachments((current) => [...current, ...acceptedResources].slice(0, uploadPolicy.maxCount));
          }
          const currentDraft = composerRef.current?.value || draft;
          const nextDraft = appendComposerReferences(currentDraft, references, {
            textLimit: SESSION_COMPOSER_TEXT_LIMIT,
          });
          if (nextDraft !== currentDraft) {
            setDraft(nextDraft);
            actions.onDraftChange?.(nextDraft);
          }
          const warning = String(result?.warning || '').trim();
          if (warning) errors.push(warning);
          if (acceptedResources.length < resources.length) {
            errors.push(`每轮最多添加 ${uploadPolicy.maxCount} 个资源。`);
          }
          else if (nextDraft === currentDraft && !acceptedResources.length) {
            errors.push(labels.directoryDropEmpty || '宿主没有返回可用的文件夹引用。');
          }
        } catch (error) {
          errors.push(error?.message || labels.directoryDropFailed || '文件夹引用失败。');
        }
      }
    }
    setAttachmentUploadState({ status: errors.length ? 'error' : 'idle', error: errors[0] || '' });
  }

  function dragStartedOutsideComposer(event) {
    return !event.target?.closest?.('agent-session-composer');
  }

  function handleWorkspaceAttachmentDrag(event) {
    if (dragStartedOutsideComposer(event)) handleAttachmentDrag(event);
  }

  function handleWorkspaceAttachmentDragLeave(event) {
    if (dragStartedOutsideComposer(event)) handleAttachmentDragLeave(event);
  }

  async function handleWorkspaceAttachmentDrop(event) {
    if (dragStartedOutsideComposer(event)) await handleAttachmentDrop(event);
  }

  async function handleComposerPaste(event) {
    const interaction = attachmentInteractionRef.current;
    if (!actions.onUploadAttachments || interaction.composerDisabled || interaction.uploading) return;
    const files = clipboardAttachmentFiles(event.clipboardData);
    if (files.length) {
      event.preventDefault();
      await uploadFiles(files);
      return;
    }
    const plainText = event.clipboardData?.getData('text/plain') || '';
    const richHtml = event.clipboardData?.getData('text/html') || '';
    const markdown = richClipboardText(richHtml, plainText);
    const structured = richClipboardHasComplexStructure(markdown, richHtml);
    const structuredAttachment = structured && uploadPolicy.structuredTextPaste === 'attachment';
    const text = structuredAttachment ? markdown : plainText || markdown;
    const attachPaste = structuredAttachment || shouldConvertPastedTextToAttachment(draft, text, {
      textLimit: SESSION_COMPOSER_TEXT_LIMIT,
    });
    if (!attachPaste) {
      if (!richHtml.trim() || !text) return;
      event.preventDefault();
      const target = event.currentTarget;
      const value = target.value || draft;
      const start = Number.isInteger(target.selectionStart) ? target.selectionStart : value.length;
      const end = Number.isInteger(target.selectionEnd) ? target.selectionEnd : start;
      const nextDraft = `${value.slice(0, start)}${text}${value.slice(end)}`;
      setDraft(nextDraft);
      actions.onDraftChange?.(nextDraft);
      requestAnimationFrame(() => {
        target.focus();
        target.setSelectionRange(start + text.length, start + text.length);
      });
      return;
    }
    event.preventDefault();
    await uploadFiles([new File(
      [text],
      `粘贴${structuredAttachment ? '内容' : '文本'}-${compactLocalTimestamp(new Date())}.${structuredAttachment ? 'md' : 'txt'}`,
      { type: structuredAttachment ? 'text/markdown' : 'text/plain' },
    )]);
  }

  function handleComposerKeyDown(event) {
    if (referenceMention) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (referenceOptions.length) {
          const direction = event.key === 'ArrowDown' ? 1 : -1;
          setReferenceActiveIndex((current) => (
            (current + direction + referenceOptions.length) % referenceOptions.length
          ));
        }
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        if (referenceOptions[referenceActiveIndex]) selectSessionReference(referenceOptions[referenceActiveIndex]);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        setReferenceMention(null);
        setReferenceOptions([]);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(compactInputMode);
    }
  }

  async function openSubagents() {
    setSubagentsOpen(true);
    await actions.onRefreshSubagents?.();
  }

  async function loadEarlier() {
    const target = transcriptRef.current;
    if (!target || !actions.onLoadEarlier || view.historyLoading) return;
    followLatestRef.current = false;
    const transcriptTop = target.getBoundingClientRect().top;
    const anchor = [...target.querySelectorAll('[data-message-id]')]
      .find((element) => element.getBoundingClientRect().bottom > transcriptTop + 8) || null;
    const anchorId = anchor?.getAttribute('data-message-id') || null;
    const anchorTop = anchor?.getBoundingClientRect().top ?? null;
    const previousHeight = target.scrollHeight;
    const previousTop = target.scrollTop;
    await actions.onLoadEarlier();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const current = transcriptRef.current;
      if (!current) return;
      const latestTop = transcriptScrollTopRef.current;
      const expectedAnchorTop = anchorTop == null ? null : anchorTop - (latestTop - previousTop);
      const currentAnchor = anchorId
        ? [...current.querySelectorAll('[data-message-id]')]
            .find((element) => element.getAttribute('data-message-id') === anchorId)
        : null;
      current.scrollTop += currentAnchor && expectedAnchorTop != null
        ? currentAnchor.getBoundingClientRect().top - expectedAnchorTop
        : current.scrollHeight - previousHeight;
      transcriptScrollTopRef.current = current.scrollTop;
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
    const save = Symbol('execution-settings-save');
    executionSettingsSaveRef.current = save;
    setExecutionSettingsSaving(true);
    Promise.resolve(actions.onExecutionProfileChange({ ...view.executionProfile, ...patch }))
      .catch((error) => actions.onError?.(error))
      .finally(() => {
        if (executionSettingsSaveRef.current !== save) return;
        executionSettingsSaveRef.current = null;
        setExecutionSettingsSaving(false);
      });
  }

  const QueuedContainer = compactComposer ? 'details' : 'section';
  function renderExecutionControls() { return (<div className="cwu-execution-controls" aria-label={labels.executionSettings || '执行设置'}>
                    <label title={labels.model || '模型'}>
                      <span>{labels.model || '模型'}</span>
                      <select
                        onFocus={loadExecutionOptions}
                        onPointerDown={loadExecutionOptions}
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
                        {splitSendComposer ? !view.models.some(model => model.id === view.executionProfile.model) ? <option value={view.executionProfile.model}>{executionModelLabel}</option> : null : !view.models.length ? <option value="">默认模型</option> : null}{view.models.map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}
                      </select>
                    </label>
                    <label title={labels.reasoning || '思考强度'}>
                      <span>{labels.reasoning || '思考'}</span>
                      <select
                        onFocus={loadExecutionOptions}
                        onPointerDown={loadExecutionOptions}
                        aria-label={labels.reasoning || '思考强度'}
                        disabled={executionControlsDisabled}
                        onChange={(event) => updateExecutionProfile({ reasoningEffort: event.target.value })}
                        value={view.executionProfile.reasoningEffort}
                      >
                        {splitSendComposer && !executionEfforts.includes(view.executionProfile.reasoningEffort) ? <option value={view.executionProfile.reasoningEffort}>{reasoningEffortLabel(view.executionProfile.reasoningEffort)}</option> : null}
                        {executionEfforts.map((effort) => <option key={effort} value={effort}>{reasoningEffortLabel(effort)}</option>)}
                      </select>
                    </label>
                    <label title={labels.permissions || '权限'}>
                      <span>{labels.permissions || '权限'}</span>
                      <select
                        onFocus={loadExecutionOptions}
                        onPointerDown={loadExecutionOptions}
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
                  </div>); }
  function renderInlineExecutionControls() {
    return <div className="cwu-inline-controls-row">{renderExecutionControls()}{!splitSendComposer && running && composer.showSecondary ? <label className="cwu-inline-submit-mode" title="发送方式"><span>发送方式</span><select aria-label="发送方式" value={mobileSubmitMode} onChange={event => setMobileSubmitMode(event.target.value)}><option value="steer">追加当前</option><option value="queue">下一轮</option></select></label> : null}</div>;
  }

  return (
    <div
      className={`cwu-session-shell ${compactComposer ? 'is-compact-composer' : ''} ${inlineExecutionControls ? 'has-inline-controls' : ''} ${splitSendComposer ? 'has-split-send-composer' : ''}`}
      data-status={view.status}
      onDragEnter={handleWorkspaceAttachmentDrag}
      onDragLeave={handleWorkspaceAttachmentDragLeave}
      onDragOver={handleWorkspaceAttachmentDrag}
      onDrop={handleWorkspaceAttachmentDrop}
    >
      <SessionDocumentPreview actions={actions} documentPreview={documentPreview} labels={labels} />
      <header className={`cwu-session-header ${actions.onBack ? 'has-back' : 'without-back'}`}>
        {actions.onBack ? <button className="cwu-quiet-button" onClick={actions.onBack} type="button">
          ← {labels.back || '返回'}
        </button> : null}
        <div className="cwu-session-heading">
          {view.contextLabel ? <span>{view.contextLabel}</span> : null}
          <h1>{view.title}</h1>
        </div>
        <div className="cwu-session-actions">
          {extensions.renderHeaderActions?.({ session: view }) || null}
          {enabledFeatures.sessionStatus ? <SessionStatus label={view.statusLabel} state={view.status} tone={sessionStatusTone(view.status)} /> : null}
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

      {extensions.renderSessionMorePanel?.({ session: view, sourceSession: session }) || null}
      <main className="cwu-session-main">
        <agent-session-stream
          className="cwu-transcript"
          onPointerDown={stopSubmitFollow}
          onScroll={updateFollowState}
          onTouchCancel={handleTranscriptTouchEnd}
          onTouchEnd={handleTranscriptTouchEnd}
          onTouchMove={handleTranscriptTouchMove}
          onTouchStart={handleTranscriptTouchStart}
          onWheel={handleTranscriptWheel}
          ref={transcriptRef}
        >
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
            {messageEntries.length ? messageEntries.map((entry) => {
              const messages = entry.kind === 'commentary-group' ? entry.messages : [entry.message];
              const trailingMessage = messages.at(-1);
              const trailingTurnKey = trailingMessage.turnKey || trailingMessage.turnId;
              const trailingTurnMetadata = technicalMetadataByTurn.get(trailingTurnKey);
              const detailTabs = technicalDetailsPresentation === 'tabbed'
                && trailingTurnKey && lastMessageByTurn.get(trailingTurnKey) === trailingMessage.id
                ? extensions.getTurnDetailTabs?.({ message: trailingMessage, session: view, turnKey: trailingTurnKey }) || []
                : [];
              const renderedMessages = messages.map((message) => (
                <React.Fragment key={message.id}>
                  <Message
                    message={message}
                    onEditMessage={enabledFeatures.messageEdit ? actions.onEditMessage : null}
                    onFinalResultVisible={actions.onFinalResultVisible}
                    onForkMessage={enabledFeatures.messageFork ? actions.onForkMessage : null}
                    onOpenAttachment={actions.onOpenAttachment}
                    onOpenLink={actions.onOpenLink}
                    onOpenSessionReference={actions.onOpenSessionReference}
                    onResolveMedia={actions.onResolveMedia}
                    onRevealLink={actions.onRevealLink}
                    revealLabel={labels.revealFile}
                    renderContent={extensions.renderMessageContent}
                    session={view}
                    sessionId={view.sessionId}
                    visualizationUrl={actions.visualizationUrl}
                  />
                  {extensions.renderAfterMessage?.({ message, session: view }) || null}
                </React.Fragment>
              ));
              const technicalDetails = enabledFeatures.technicalDetails
                    && trailingTurnKey
                    && lastMessageByTurn.get(trailingTurnKey) === trailingMessage.id
                    && (technicalByTurn.get(trailingTurnKey)?.length || technicalDetailsAvailable.has(trailingTurnKey) || detailTabs.length) ? (
                      <TechnicalDetails
                        progressive={['progressive', 'tabbed'].includes(technicalDetailsPresentation)}
                        detailTabs={technicalDetailsPresentation === 'tabbed' ? detailTabs : null}
                        manualTab={detailTabByTurn[`${view.sessionId}:${trailingTurnKey}`]}
                        onTabChange={id => setDetailTabByTurn(current => ({ ...current, [`${view.sessionId}:${trailingTurnKey}`]: id }))}
                        loaded={view.technicalDetailsLoaded.includes(trailingTurnKey)}
                        compactPresentation={compactComposer}
                        key={`${view.sessionId}:${trailingTurnKey}`}
                        manualOpen={processOpenByTurn[`${view.sessionId}:${trailingTurnKey}`] ?? null}
                        onOpenChange={(open) => setProcessOpenByTurn(current => ({ ...current, [`${view.sessionId}:${trailingTurnKey}`]: open }))}
                        available={technicalDetailsAvailable.has(trailingTurnKey)}
                        itemCount={trailingTurnMetadata?.technicalItemCount}
                        items={technicalByTurn.get(trailingTurnKey) || []}
                        loading={view.technicalDetailsLoading}
                        onOpenArtifact={actions.onOpenArtifact}
                        onResolveMedia={actions.onResolveMedia}
                        onLoad={actions.onLoadTechnicalDetails
                          ? () => actions.onLoadTechnicalDetails(trailingTurnKey)
                          : null}
                        onLoadItem={actions.onLoadTechnicalItem
                          ? (itemId) => actions.onLoadTechnicalItem(trailingTurnKey, itemId)
                          : null}
                        onRevealArtifact={actions.onRevealArtifact}
                        sessionId={view.sessionId}
                        startedAt={trailingTurnMetadata?.startedAt || trailingMessage.createdAt}
                        completedAt={trailingTurnMetadata?.completedAt}
                        running={trailingMessage.turnStatus === 'inProgress'
                          || (running && trailingTurnKey === view.turnMetadata.at(-1)?.turnKey)}
                        turnStatus={trailingMessage.turnStatus}
                        turnOrdinal={trailingTurnMetadata?.ordinal}
                      />
                    ) : null;
              return (
                <React.Fragment key={entry.id}>
                  {entry.kind === 'commentary-group' ? (
                    <CommentaryGroup
                      initiallyOpen={entry.id === latestCommentaryGroupId}
                      messageCount={messages.length}
                    >{renderedMessages}</CommentaryGroup>
                  ) : renderedMessages}
                  {technicalDetails}
                </React.Fragment>
              );
            }) : (
              <div className="cwu-empty">
                <h2>{labels.emptyTitle || '开始处理这项工作'}</h2>
                <p>{labels.emptyBody || '输入需求后，这个 Session 会保留完整过程。'}</p>
              </div>
            )}

            {view.status === 'running' ? (
              <RuntimeProgress
                activityKind={view.activityKind}
                activityLabel={view.activityLabel}
                plan={view.plan}
              />
            ) : null}

            {view.pendingRequests.map((request) => (
              <SessionRequestCard
                key={request.token}
                request={request}
                onRespond={actions.onRespondToRequest}
              />
            ))}

            {enabledFeatures.technicalDetails && technicalByTurn.get('unassigned')?.length ? (
              <TechnicalDetails
                progressive={['progressive', 'tabbed'].includes(technicalDetailsPresentation)}
                detailTabs={technicalDetailsPresentation === 'tabbed' ? [] : null}
                compactPresentation={compactComposer}
                items={technicalByTurn.get('unassigned')}
                onOpenArtifact={actions.onOpenArtifact}
                onRevealArtifact={actions.onRevealArtifact}
              />
            ) : null}
            {extensions.renderAfterMessages?.({ session: view }) || null}
          </div>
        </agent-session-stream>

        <footer className="cwu-composer-wrap">
          {extensions.renderComposerReplacement?.({ session: view }) || null}
          {awayFromLatest ? (
            <button
              aria-label={hasNewMessagesBelow
                ? (labels.scrollToLatestWithNewMessages || '滚动到最新消息，有新消息')
                : (labels.scrollToLatest || '滚动到最新消息')}
              className={`cwu-scroll-latest ${hasNewMessagesBelow ? 'has-new-messages' : ''}`}
              onClick={scrollToLatest}
              type="button"
            >
              <span aria-hidden="true">↓</span>
              {hasNewMessagesBelow ? <small>{labels.newMessages || '有新消息'}</small> : null}
            </button>
          ) : null}
          {enabledFeatures.queuedTurns && view.queuedTurns.length ? (
            <QueuedContainer aria-label={labels.queuedTitle || '下一轮待发送'} className="cwu-queued-turns">
              {compactComposer ? <summary>下一轮 · {view.queuedTurns.length} 条待发送</summary> : <header><strong>{labels.queuedTitle || '下一轮待发送'}</strong><span>{view.queuedTurns.length} 条</span></header>}
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
            </QueuedContainer>
          ) : null}
          {extensions.renderComposerReplacement ? null : <agent-session-composer
            className={`cwu-composer ${attachmentDragActive ? 'is-dragging' : ''}`}
            onDragEnter={handleAttachmentDrag}
            onDragLeave={handleAttachmentDragLeave}
            onDragOver={handleAttachmentDrag}
            onDrop={handleAttachmentDrop}
          >
          {attachmentDragActive ? (
            <div className="cwu-attachment-dropzone" role="status">{
              attachmentDragKind === 'session-reference'
                ? (labels.sessionReferenceDrop || '引用这个 Session')
                : attachmentDragKind === 'invalid-reference-mix'
                  ? (labels.sessionReferenceMixedDrop || 'Session 引用不能与文件混合拖放')
              : attachmentDragKind === 'directories'
                ? (labels.directoryDrop || '松开以引用文件夹')
                : attachmentDragKind === 'mixed'
                  ? (labels.mixedDrop || '松开以添加文件夹引用和附件')
                  : (labels.attachmentDrop || '松开以上传附件')
            }</div>
          ) : null}
          <form className="cwu-composer-form" onSubmit={(event) => { event.preventDefault(); if (compactInputMode) submit(compactInputMode); }}>
            {extensions.renderComposerOverlay?.({ draft, session: view, setDraft }) || null}
            {referenceMention ? (
              <div aria-label={labels.sessionReferencePicker || '选择 Session'} className="cwu-reference-picker" role="listbox">
                {referenceSearchState.loading ? <div className="cwu-reference-picker-state">{labels.sessionReferenceLoading || '正在搜索…'}</div> : null}
                {!referenceSearchState.loading && referenceSearchState.error ? (
                  <div className="cwu-reference-picker-state is-error" role="alert">{referenceSearchState.error}</div>
                ) : null}
                {!referenceSearchState.loading && !referenceSearchState.error && !referenceOptions.length ? (
                  <div className="cwu-reference-picker-state">{labels.sessionReferenceEmpty || '没有匹配的 Session'}</div>
                ) : null}
                {referenceOptions.map((reference, index) => (
                  <button
                    aria-selected={index === referenceActiveIndex}
                    className={index === referenceActiveIndex ? 'is-active' : ''}
                    key={sessionReferenceKey(reference)}
                    onClick={() => selectSessionReference(reference)}
                    onMouseEnter={() => setReferenceActiveIndex(index)}
                    role="option"
                    type="button"
                  >
                    <strong>{reference.label}</strong>
                    <small>
                      {[reference.contextLabel, reference.archived ? '已归档' : '', reference.updatedAt ? defaultFormatTime(reference.updatedAt) : '']
                        .filter(Boolean).join(' · ')}
                    </small>
                  </button>
                ))}
              </div>
            ) : null}
            {references.length ? (
              <div aria-label={labels.sessionReferences || '已引用 Sessions'} className="cwu-references">
                {references.map((reference) => (
                  <span className={reference.unavailable ? 'is-unavailable' : ''} key={sessionReferenceKey(reference)}>
                    <i aria-hidden="true">@</i>
                    <strong title={reference.label}>{reference.label}</strong>
                    {reference.unavailable ? <small>不可用</small> : null}
                    <button
                      aria-label={`移除 Session 引用：${reference.label}`}
                      disabled={submitting}
                      onClick={() => {
                        setReferences((current) => current.filter((item) => sessionReferenceKey(item) !== sessionReferenceKey(reference)));
                        setReferenceSearchState({ loading: false, error: '' });
                      }}
                      title="移除引用"
                      type="button"
                    >×</button>
                  </span>
                ))}
              </div>
            ) : null}
            {!referenceMention && referenceSearchState.error ? (
              <span className="cwu-reference-error" role="alert">{referenceSearchState.error}</span>
            ) : null}
            {attachments.length || attachmentUploadState.error ? (
              <div className="cwu-attachments" aria-live="polite">
                {attachments.map((attachment) => (
                  <article className={`cwu-attachment is-${attachment.status || 'ready'}`} key={attachment.id}>
                    <i aria-hidden="true">{attachment.kind === 'image' ? '▧' : attachment.kind === 'audio' ? '♪' : attachment.kind === 'directory' ? '▱' : '▤'}</i>
                    <div>
                      <strong title={attachment.name}>{attachment.name}</strong>
                      <small>
                        {attachment.status === 'uploading'
                          ? `上传中 ${Math.round(attachment.progress || 0)}%`
                          : attachment.status === 'error'
                            ? (attachment.error || '上传失败')
                            : attachment.kind === 'directory'
                              ? '文件夹 · 已就绪'
                              : `${formatAttachmentSize(attachment.size)} · 已就绪`}
                      </small>
                      {attachment.status === 'uploading' ? (
                        <span className="cwu-attachment-progress"><i style={{ width: `${attachment.progress || 0}%` }} /></span>
                      ) : null}
                    </div>
                    <div className="cwu-attachment-actions">
                      {attachment.status === 'error' && attachment.file ? (
                        <button
                          aria-label={`重试上传 ${attachment.name}`}
                          disabled={submitting || uploading}
                          onClick={() => retryAttachment(attachment)}
                          type="button"
                        >重试</button>
                      ) : null}
                      <button
                        aria-label={`移除 ${attachment.name}`}
                        disabled={submitting}
                        onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                        type="button"
                      >×</button>
                    </div>
                  </article>
                ))}
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
                updateReferenceMention(event.target.value, event.target.selectionStart);
              }}
              onKeyDown={handleComposerKeyDown}
              onPaste={handleComposerPaste}
              placeholder={labels.composerPlaceholder || '补充需求、反馈问题，或者继续修改…'}
              readOnly={composerReadOnly}
              ref={composerRef}
              rows={compactComposer ? 2 : 3}
              value={draft}
            />
            {!composerOptionsOpen ? renderExecutionOptionsStatus() : null}
            <div className="cwu-composer-footer" ref={composerFooterRef}>
              <div className="cwu-composer-meta">
                {enabledFeatures.attachments === 'visible' && actions.onUploadAttachments ? (
                  <label
                    aria-disabled={submitting || uploading || attachments.length >= uploadPolicy.maxCount}
                    className="cwu-attach-button"
                    ref={composerAttachmentRef}
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
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14"/></svg>附件
                  </label>
                ) : null}
                {compactComposer ? inlineExecutionControls ? renderInlineExecutionControls() : renderComposerOptionsButton() : !executionSettingsLocked && view.models.length && actions.onExecutionProfileChange ? (
                  renderExecutionControls()
                ) : executionSettingsLocked ? (
                  <>
                    <button
                      aria-controls="cwu-execution-settings-popover"
                      aria-expanded={executionSettingsOpen}
                      aria-haspopup="dialog"
                      aria-label="查看当前执行设置"
                      className="cwu-execution-summary"
                      onClick={() => setExecutionSettingsOpen((open) => !open)}
                      ref={executionSettingsButtonRef}
                      type="button"
                    >
                      <span>执行设置</span><span aria-hidden="true" className="cwu-execution-info">ⓘ</span>
                    </button>
                  </>
                ) : view.executionProfile.label ? <span className="cwu-execution-profile">{view.executionProfile.label}</span> : null}
              </div>
              <div className="cwu-composer-actions" ref={composerActionsRef}>
                {extensions.renderComposerActions?.({ session: view, draft, setDraft, disabled: composerDisabled, onRecordingChange: setComposerReadOnly }) || null}
                {running && actions.onInterrupt ? (
                  <button
                    aria-label="停止当前处理"
                    className="cwu-button cwu-stop"
                    onClick={actions.onInterrupt}
                    title="停止当前处理"
                    type="button"
                  >{compactComposer ? <svg aria-hidden="true" viewBox="0 0 24 24"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> : '停止'}</button>
                ) : null}
                {!compactComposer && composer.showSecondary ? (
                  <button className="cwu-button" disabled={!canSubmit} onClick={() => submit(composer.secondaryMode)} type="button">
                    {composer.secondaryLabel}
                  </button>
                ) : null}
                {splitSendComposer && running && composer.showSecondary ? <div className="cwu-send-action-group" ref={sendModeGroupRef}>
                  <button className="cwu-send" disabled={!canSubmit} title={compactInputLabel} type="submit">{compactInputLabel}</button>
                  <button className="cwu-send-mode-trigger" type="button" aria-label={`发送方式 · ${compactInputLabel}`}
                    aria-haspopup="menu" aria-expanded={sendModeOpen} aria-controls={sendModeId} ref={sendModeButtonRef}
                    onClick={() => setSendModeOpen(open => !open)}
                    onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSendModeOpen(true); } }}>
                    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6"/></svg>
                  </button>
                  {sendModeOpen ? <div id={sendModeId} className="cwu-send-mode-menu" role="menu" aria-label="发送方式" ref={sendModeMenuRef}
                    onKeyDown={handleSendModeKeyDown} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && event.relatedTarget !== sendModeButtonRef.current) setSendModeOpen(false); }}>
                    {[["steer", "追加当前", "接着处理这轮任务"], ["queue", "下一轮", "这轮完成后再处理"]].map(([mode, label, description]) => <button
                      key={mode} type="button" role="menuitemradio" aria-checked={compactInputMode === mode} tabIndex={compactInputMode === mode ? 0 : -1}
                      onClick={() => chooseSendMode(mode)}><strong>{label}</strong><span>{description}</span></button>)}
                  </div> : null}
                </div> : <button className="cwu-send" disabled={!canSubmit} title={compactInputLabel} type="submit">
                  {compactInputLabel}
                </button>}
              </div>
            </div>
            {compactComposer ? <div aria-hidden="true" inert className="cwu-composer-width-probe" ref={composerWidthProbeRef}>{renderInlineExecutionControls()}</div> : null}
            {splitSendComposer ? <div aria-hidden="true" inert className="cwu-composer-width-probe" ref={composerOptionsWidthProbeRef}>{renderComposerOptionsButton({ probe: true })}</div> : null}
          </form>
          </agent-session-composer>}
        </footer>
      </main>
      {composerOptionsOpen ? <div className="cwu-composer-options-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setComposerOptionsOpen(false); }}><section className="cwu-composer-options-sheet" role="dialog" aria-modal="true" aria-label="输入选项" tabIndex={-1} ref={composerOptionsRef}><div className="cwu-sheet-handle"/><header><strong>输入选项</strong><button aria-label="关闭输入选项" type="button" onClick={() => setComposerOptionsOpen(false)}>×</button></header>{renderExecutionOptionsStatus()}{renderExecutionControls()}{extensions.renderComposerOptions?.({ session: view, draft, setDraft, disabled: composerDisabled, onRecordingChange: setComposerReadOnly, close: () => setComposerOptionsOpen(false) }) || null}{!splitSendComposer && running ? <div className="cwu-mobile-submit-mode"><span>发送方式</span><div>{[['steer', '追加当前'], ['queue', '下一轮']].map(([mode, label]) => <button key={mode} type="button" aria-pressed={mobileSubmitMode === mode} onClick={() => setMobileSubmitMode(mode)}>{label}</button>)}</div></div> : null}<button className="cwu-send" type="button" onClick={() => setComposerOptionsOpen(false)}>完成</button></section></div> : null}
      {executionSettingsOpen ? (
        <div
          aria-label="当前执行设置"
          className="cwu-execution-popover"
          data-side={executionPopoverPosition.side}
          id="cwu-execution-settings-popover"
          ref={executionSettingsPopoverRef}
          role="dialog"
          style={{ left: executionPopoverPosition.left, top: executionPopoverPosition.top }}
        >
          <span><small>{labels.model || '模型'}</small><strong title={executionModelLabel}>{executionModelLabel}</strong></span>
          <span><small>{labels.reasoning || '思考'}</small><strong>{reasoningEffortLabel(view.executionProfile.reasoningEffort)}</strong></span>
          <span><small>{labels.permissions || '权限'}</small><strong>{executionAccessLabel}</strong></span>
          <span><small>模式</small><strong>{view.executionProfile.serviceTier === 'priority' ? 'Fast' : '标准'}</strong></span>
        </div>
      ) : null}
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

export function SubagentCard({ agent, actions, mode = 'full', openLabel = '打开线程' }) {
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
          {actions.onOpenSubagent ? <button className="cwu-button" onClick={() => actions.onOpenSubagent(agent)} type="button">{openLabel}</button> : null}
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

function RealtimePanel({ enabled, event, initialState, labels = {}, onFallback, onSend, inline = false }) {
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
      dialog: inline ? { open: true, showModal() {}, close() {}, addEventListener: (...args) => dialogRef.current.addEventListener(...args) } : dialogRef.current,
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
      controller.dispose();
      controllerRef.current = null;
    };
  }, [inline]);

  useEffect(() => {
    controllerRef.current?.setEnabled(enabled);
  }, [enabled]);

  useEffect(() => {
    if (inline) controllerRef.current?.open();
  }, [inline]);

  useEffect(() => {
    if (!event?.type) return;
    controllerRef.current?.handleMessage(event.type, event.payload || {});
  }, [event]);

  const Surface = inline ? 'section' : 'dialog';
  return (
    <>
      <button className="cwu-button cwu-realtime-launch" hidden={inline} ref={launchRef} title="Realtime V3" type="button">
        {labels.realtimeButton || '语音'}
      </button>
      <Surface className={`cwu-realtime-dialog${inline ? ' is-inline' : ''}`} aria-label="实时语音对话" ref={dialogRef}>
        <section className="cwu-realtime-shell">
          <header hidden={inline}>
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
      </Surface>
    </>
  );
}

function RevealFolderIcon() {
  return (
    <svg aria-hidden="true" fill="none" viewBox="0 0 20 20">
      <path d="M2.75 5.25h5l1.45 1.5h8.05v8H2.75z" />
      <path d="M2.75 6.75v-2h4.6l1.4 1.5" />
    </svg>
  );
}

function markdownLinkComponents(onOpenLink, onRevealLink, revealLabel = '在文件夹中显示') {
  if (!onOpenLink) return undefined;
  return {
    a: ({ href = '', children, ...props }) => {
      if (/^https?:\/\//i.test(href)) {
        return <a {...props} href={href} rel="noreferrer" target="_blank">{children}</a>;
      }
      const localFile = isLocalFileHref(href);
      const link = (
        <a
          {...props}
          href={localFile ? localFileBrowserHref(href) : href}
          onClick={(event) => {
            event.preventDefault();
            onOpenLink(href);
          }}
        >{children}</a>
      );
      if (!onRevealLink || !localFile) return link;
      return (
        <span className="cwu-local-file-link">
          {link}
          <button
            aria-label={revealLabel}
            className="cwu-local-file-reveal"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRevealLink(href);
            }}
            title={revealLabel}
            type="button"
          ><RevealFolderIcon /></button>
        </span>
      );
    },
  };
}

function documentMarkdownComponents({ documentResourceUrl, file, onOpenLink, onRevealLink, revealLabel = '在文件夹中显示' }) {
  return {
    a: ({ href = '', children, ...props }) => {
      if (href.startsWith('#')) {
        return <a {...props} href={href} onClick={(event) => scrollDocumentAnchor(event, href)}>{children}</a>;
      }
      if (/^https?:\/\//i.test(href)) {
        return <a {...props} href={href} rel="noreferrer" target="_blank">{children}</a>;
      }
      const localFile = isDocumentResourceHref(href);
      const link = (
        <a
          {...props}
          href={localFile ? localFileBrowserHref(href) : href}
          onClick={(event) => {
            if (!onOpenLink) return;
            event.preventDefault();
            onOpenLink(href, file);
          }}
        >{children}</a>
      );
      if (!onRevealLink || !localFile) return link;
      return (
        <span className="cwu-local-file-link">
          {link}
          <button
            aria-label={revealLabel}
            className="cwu-local-file-reveal"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onRevealLink(href, file);
            }}
            title={revealLabel}
            type="button"
          ><RevealFolderIcon /></button>
        </span>
      );
    },
    img: ({ src = '', alt = '', ...props }) => (
      <img
        {...props}
        alt={alt}
        loading="lazy"
        src={resolveDocumentResourceHref(file, src, documentResourceUrl)}
      />
    ),
  };
}

function scrollDocumentAnchor(event, href) {
  event.preventDefault();
  let id = String(href || '').replace(/^#/, '');
  try { id = decodeURIComponent(id); } catch {}
  const preview = event.currentTarget.closest('.cwu-document-preview');
  const target = [...(preview?.querySelectorAll('[id]') || [])].find((element) => element.id === id);
  target?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function rehypeDocumentHeadingIds() {
  return (tree) => {
    const seen = new Map();
    walkMarkdownTree(tree, (node) => {
      if (node?.type !== 'element' || !/^h[1-6]$/.test(node.tagName || '')) return;
      const base = markdownHeadingId(markdownNodeText(node));
      const count = seen.get(base) || 0;
      seen.set(base, count + 1);
      node.properties = { ...(node.properties || {}), id: count ? `${base}-${count}` : base };
    });
  };
}

function walkMarkdownTree(node, visit) {
  visit(node);
  for (const child of node?.children || []) walkMarkdownTree(child, visit);
}

function markdownNodeText(node) {
  if (node?.type === 'text') return String(node.value || '');
  return (node?.children || []).map(markdownNodeText).join('');
}

function DocumentPreview({
  documentResourceUrl,
  file,
  onClose,
  onDownload,
  onEdit,
  onOpenExternal,
  onOpenLink,
  onReveal,
  onRevealLink,
  onSave,
  revealLabel,
}) {
  const preview = useMemo(() => documentPreviewPresentation(file), [file]);
  const tabs = documentPreviewTabs(file);
  const canEditInline = Boolean(onSave && file.path && !file.attachmentId && file.format === 'markdown');
  const [activeTab, setActiveTab] = useState(tabs[0]?.id || 'content');
  const [editing, setEditing] = useState(false);
  const [editorContent, setEditorContent] = useState(String(file.content || ''));
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const openerRef = useRef(null);
  const dialogRef = useRef(null);
  const dirty = editing && editorContent !== String(file.content || '');

  useEffect(() => {
    setActiveTab(tabs[0]?.id || 'content');
    setEditing(false);
    setEditorContent(String(file.content || ''));
    setSaving(false);
    setSaveError('');
  }, [file.attachmentId, file.name, file.path, file.version, file.format]);

  useEffect(() => {
    openerRef.current = document.activeElement;
    dialogRef.current?.querySelector('.cwu-document-close')?.focus();
    return () => openerRef.current?.focus?.();
  }, []);

  function confirmDiscard() {
    return !dirty || globalThis.confirm?.('文件还有未保存的修改，确定放弃吗？') !== false;
  }

  function closePreview() {
    if (saving || !confirmDiscard()) return;
    onClose?.();
  }

  function cancelEditing() {
    if (saving || !confirmDiscard()) return;
    setEditorContent(String(file.content || ''));
    setSaveError('');
    setEditing(false);
  }

  async function saveDocument() {
    if (!onSave || !dirty || saving) return;
    setSaving(true);
    setSaveError('');
    try {
      const result = await onSave({ file, content: editorContent, version: file.version || null });
      const savedFile = result?.file || result || { ...file, content: editorContent };
      setEditorContent(String(savedFile.content ?? editorContent));
      setEditing(false);
    } catch (error) {
      setSaveError(error?.message || '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function copyDocumentView() {
    const text = documentPreviewCopyText(file, activeTab);
    if (text != null) await navigator.clipboard?.writeText?.(text);
  }

  useEffect(() => {
    function handleKeyDown(event) {
      if (event.key === 'Escape') {
        if (editing) cancelEditing();
        else closePreview();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...(dialogRef.current?.querySelectorAll('a[href], button:not([disabled]), textarea, [tabindex]:not([tabindex="-1"])') || [])];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [dirty, editing, file.content, onClose, saving]);

  return (
    <div
      aria-label={`文件预览：${file.name}`}
      aria-modal="true"
      className={`cwu-document-backdrop${file.format === 'image' ? ' is-image' : ''}`}
      onMouseDown={(event) => { if (event.target === event.currentTarget) closePreview(); }}
      role="dialog"
    >
      <section className="cwu-document-preview" ref={dialogRef}>
        <header>
          <div><span>{editing ? '本地 Markdown · 编辑中' : `${file.sourceLabel || (file.attachmentId ? 'Session 附件' : file.resource ? 'Session 产物' : '本地文件')} · ${file.mimeType || '未知类型'} · ${formatAttachmentSize(file.size)}`}</span><h2>{file.name}</h2></div>
          <div>
            {editing ? (
              <>
                <button className="cwu-button" disabled={saving} onClick={cancelEditing} type="button">取消</button>
                <button className="cwu-button is-primary" disabled={!dirty || saving} onClick={saveDocument} type="button">{saving ? '保存中…' : '保存'}</button>
              </>
            ) : (
              <>
                {file.downloadUrl ? <a className="cwu-button" download={file.name} href={file.downloadUrl}>下载</a> : onDownload ? <button className="cwu-button" onClick={() => onDownload(file)} type="button">下载</button> : null}
                {!file.loading && documentPreviewCopyText(file, activeTab) != null ? <button className="cwu-button" onClick={copyDocumentView} type="button">复制</button> : null}
                {onReveal && (file.path || file.attachmentId) ? <button className="cwu-button" onClick={() => onReveal(file)} type="button">文件夹</button> : null}
                {canEditInline ? <button className="cwu-button" onClick={() => setEditing(true)} type="button">编辑</button> : onEdit && file.path && !file.attachmentId ? <button className="cwu-button" onClick={() => onEdit(file)} type="button">编辑</button> : null}
                {onOpenExternal ? <button className="cwu-button" onClick={() => onOpenExternal(file)} type="button">外部打开</button> : null}
              </>
            )}
            <button aria-label="关闭文件预览" className="cwu-document-close" onClick={closePreview} type="button">×</button>
          </div>
        </header>
        {!editing && tabs.length > 1 ? (
          <nav aria-label="文件查看方式" className="cwu-document-tabs">
            {tabs.map((tab) => <button aria-pressed={activeTab === tab.id} key={tab.id} onClick={() => setActiveTab(tab.id)} type="button">{tab.label}</button>)}
          </nav>
        ) : editing ? <div className="cwu-document-editor-bar"><span>{dirty ? '有未保存的修改' : '尚未修改'}</span>{saveError ? <strong role="alert">{saveError}</strong> : null}</div> : null}
        <div className="cwu-document-body">
          {editing ? (
            <textarea
              aria-label={`编辑 ${file.name}`}
              autoFocus
              className="cwu-document-editor"
              onChange={(event) => { setEditorContent(event.target.value); setSaveError(''); }}
              spellCheck={false}
              value={editorContent}
            />
          ) : file.loading ? (
            <div aria-label="正在加载文件预览" className="cwu-document-loading"><i /><i /><i /></div>
          ) : file.previewError ? (
            <DocumentPreviewError error={file.previewError} />
          ) : file.format === 'image' ? (
            <div className="cwu-document-image"><img alt={file.name} src={file.src} /></div>
          ) : file.format === 'pdf' ? (
            <iframe className="cwu-document-pdf" src={file.src} title={file.name} />
          ) : file.format === 'audio' ? (
            <div className="cwu-document-audio"><audio controls src={file.src} /></div>
          ) : file.format === 'spreadsheet' ? (
            <SpreadsheetPreview file={file} />
          ) : file.format === 'csv' && activeTab === 'table' ? (
            file.csv ? <CsvPreview csv={file.csv} /> : <DocumentPreviewError error={file.csvError || { message: '无法生成 CSV 表格预览。' }} />
          ) : file.format === 'csv' && activeTab === 'raw' ? (
            file.rawAvailable ? <DocumentCodePreview file={{ ...file, content: file.rawText || '', format: 'code' }} /> : <DocumentPreviewError error={file.rawError} />
          ) : file.format === 'html' && activeTab === 'preview' ? (
            <iframe
              className="cwu-document-html"
              referrerPolicy="no-referrer"
              sandbox="allow-scripts"
              srcDoc={sandboxedHtmlSource(file.content || '')}
              title={file.name}
            />
          ) : file.format === 'markdown' && activeTab === 'preview' ? (
            file.rawAvailable !== false ? (
              <div className="cwu-document-content cwu-message-body">
                <SessionMarkdown
                  components={documentMarkdownComponents({ documentResourceUrl, file, onOpenLink, onRevealLink, revealLabel })}
                  mode="document"
                  headingPlugin={rehypeDocumentHeadingIds}
                >{normalizeMarkdownMath(file.rawText ?? file.content ?? '')}</SessionMarkdown>
              </div>
            ) : <DocumentPreviewError error={file.rawError} />
          ) : file.format === 'markdown' && activeTab === 'raw' ? (
            file.rawAvailable !== false ? <DocumentCodePreview file={{ ...file, content: file.rawText ?? file.content ?? '', format: 'code' }} /> : <DocumentPreviewError error={file.rawError} />
          ) : file.format === 'sql' ? (
            file.rawAvailable === false
              ? <DocumentPreviewError error={file.rawError} />
              : <DocumentCodePreview file={{ ...file, content: activeTab === 'raw' ? file.rawText ?? file.content ?? '' : file.formattedText ?? file.rawText ?? file.content ?? '', format: 'sql' }} />
          ) : file.format === 'text' && file.rawAvailable === false ? (
            <DocumentPreviewError error={file.rawError} />
          ) : file.format === 'unsupported' ? (
            <DocumentPreviewError error={{ message: '暂不支持站内预览此文件类型，请下载原文件。' }} />
          ) : preview.code || activeTab === 'source' ? (
            <DocumentCodePreview file={file} />
          ) : <pre className={`cwu-document-text${(file.rawText ?? file.content ?? '') === '' ? ' is-empty' : ''}`}>{(file.rawText ?? file.content ?? '') === '' ? '空文件' : (file.rawText ?? file.content)}</pre>}
        </div>
      </section>
    </div>
  );
}

function DocumentCodePreview({ file }) {
  const preview = useMemo(() => documentPreviewPresentation(file), [file]);
  const tokenLines = useMemo(() => file.format === 'sql' ? sqlPreviewTokenLines(file.content) : null, [file.content, file.format]);
  const highlightedLineRef = useRef(null);

  useEffect(() => {
    if (!preview.highlightLine) return undefined;
    const frame = requestAnimationFrame(() => {
      highlightedLineRef.current?.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [file.name, file.path, preview.highlightLine]);

  return (
    <div aria-label={`${file.name} 源码`} className="cwu-document-code" role="list">
      {preview.lines.map((line, index) => {
        const lineNumber = index + 1;
        const highlighted = lineNumber === preview.highlightLine;
        return (
          <div
            aria-current={highlighted ? 'location' : undefined}
            className={`cwu-document-code-line ${highlighted ? 'is-highlighted' : ''}`}
            key={lineNumber}
            ref={highlighted ? highlightedLineRef : undefined}
            role="listitem"
          >
            <span aria-hidden="true" className="cwu-document-line-number">{lineNumber}</span>
            <code>{tokenLines ? tokenLines[index].map((token, tokenIndex) => (
              <span className={`cwu-sql-${token.type}`} key={`${tokenIndex}-${token.text}`}>{token.text}</span>
            )) : line || '\u00a0'}</code>
          </div>
        );
      })}
    </div>
  );
}

function CsvPreview({ csv }) {
  return (
    <div className="cwu-csv-preview">
      <div className="cwu-csv-scroll">
        <table>
          <thead><tr>{csv.headers.map((header, index) => <th key={`${header}-${index}`}>{header}</th>)}</tr></thead>
          <tbody>{csv.rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex}>{cell}</td>)}</tr>
          ))}</tbody>
        </table>
      </div>
      {csv.hasMore ? <p>仅预览前 200 行，下载查看完整文件</p> : <p>首行作为列名 · 共预览 {csv.previewedRows} 行</p>}
    </div>
  );
}

function DocumentPreviewError({ error }) {
  return <div className="cwu-document-error" role="status"><strong>无法预览</strong><p>{error?.message || '文件预览不可用，请下载原文件。'}</p></div>;
}

function documentPreviewTabs(file) {
  if (file.loading) return [];
  if (file.format === 'markdown') return [{ id: 'preview', label: '预览' }, { id: 'raw', label: 'Raw' }];
  if (file.format === 'sql') return [{ id: 'formatted', label: '格式化' }, { id: 'raw', label: '原文' }];
  if (file.format === 'csv') return [{ id: 'table', label: '表格' }, { id: 'raw', label: 'Raw' }];
  if (file.format === 'html') return [{ id: 'preview', label: '预览' }, { id: 'source', label: '源码' }];
  return [];
}

function documentPreviewCopyText(file, activeTab) {
  if (file.loading || file.previewError || ['image', 'pdf', 'audio', 'unsupported'].includes(file.format)) return null;
  if (file.format === 'csv' && activeTab === 'table' && file.csv) {
    return [file.csv.headers, ...file.csv.rows].map((row) => row.join('\t')).join('\n');
  }
  if (file.format === 'sql' && activeTab === 'formatted') return file.formattedText ?? file.rawText ?? '';
  if (file.rawAvailable === false && ['csv', 'markdown', 'sql', 'text'].includes(file.format)) return null;
  return file.rawText ?? file.content ?? '';
}

function sqlPreviewTokenLines(content) {
  const lines = [[]];
  for (const token of tokenizeSqlPreview(content)) {
    const parts = token.text.split('\n');
    parts.forEach((part, index) => {
      if (part) lines.at(-1).push({ ...token, text: part });
      if (index < parts.length - 1) lines.push([]);
    });
  }
  return lines;
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

function ScrollRegion({ className, bounded = false, ariaLabel, ariaBusy, children, id }) {
  const scrollRef = useRef(null);
  const contentRef = useRef(null);
  const hintId = useId();
  const [edges, setEdges] = useState({ overflow: false, above: false, below: false });
  const updateEdges = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const contentHeight = contentRef.current?.getBoundingClientRect().height || 0;
    const remaining = Math.max(contentHeight, element.scrollHeight) - element.clientHeight;
    const overflow = remaining > 4;
    if (!overflow) element.scrollTop = 0;
    const next = { overflow, above: overflow && element.scrollTop > 4, below: overflow && remaining - element.scrollTop > 4 };
    setEdges(previous => previous.overflow === next.overflow && previous.above === next.above && previous.below === next.below ? previous : next);
  }, []);
  useEffect(() => {
    if (!bounded) return;
    updateEdges();
    const observer = new ResizeObserver(updateEdges);
    for (const element of [scrollRef.current, contentRef.current].filter(Boolean)) observer.observe(element);
    return () => observer.disconnect();
  }, [bounded, updateEdges]);
  if (!bounded) return <div className={className} id={id} aria-label={ariaLabel} aria-busy={ariaBusy}>{children}</div>;
  return <div className={`cwu-scroll-region ${className}`} id={id} aria-busy={ariaBusy} data-overflow={edges.overflow ? 'true' : undefined}>
    <div className="cwu-scroll-content" ref={scrollRef} onScroll={edges.overflow ? updateEdges : undefined} tabIndex={edges.overflow ? 0 : undefined} role={edges.overflow ? 'region' : undefined} aria-label={edges.overflow ? ariaLabel : undefined} aria-describedby={edges.below ? hintId : undefined}>
      <div className="cwu-scroll-copy" ref={contentRef}>{children}</div>
    </div>
    {edges.above ? <div className="cwu-scroll-fade-top" aria-hidden="true"/> : null}
    {edges.below ? <button className="cwu-scroll-hint" id={hintId} type="button" title="向下滚动查看更多" onClick={() => scrollRef.current?.scrollBy({ top: Math.min(scrollRef.current.clientHeight * .75, 240), behavior: 'smooth' })}><span className="cwu-scroll-hint-label">向下滚动查看更多</span><svg aria-hidden="true" viewBox="0 0 24 24" fill="none"><path d="M12 5v14m-5-5 5 5 5-5"/></svg></button> : null}
  </div>;
}

function Message({
  message,
  onEditMessage,
  onFinalResultVisible,
  onForkMessage,
  onOpenAttachment,
  onOpenLink,
  onOpenSessionReference,
  onResolveMedia,
  onRevealLink,
  revealLabel,
  renderContent,
  session,
  sessionId,
  visualizationUrl,
}) {
  const isUser = message.role === 'user';
  const isCommentary = message.phase === 'commentary';
  const isFinalResult = message.role === 'assistant' && !isCommentary && message.turnStatus !== 'inProgress';
  const messageRef = useRef(null);
  const finalResultReportedRef = useRef(false);
  const publishesMedia = sessionMessagePublishesMedia(message);
  const [editing, setEditing] = useState(false);
  const [editDraft, setEditDraft] = useState(message.content);
  const [savingEdit, setSavingEdit] = useState(false);
  const [forking, setForking] = useState(false);
  const canEdit = isUser && message.canEdit && typeof onEditMessage === 'function';
  const canFork = isUser && message.canFork && typeof onForkMessage === 'function';
  const markdownComponents = {
    ...(markdownLinkComponents(onOpenLink, onRevealLink, revealLabel) || {}),
    ...(!publishesMedia ? { img: () => null } : {}),
  };
  const inline = extractVisualizationReferences(message.content);
  const visualizations = typeof visualizationUrl === 'function'
    ? inline.references.map((reference) => ({
        ...reference,
        src: visualizationUrl({ ...reference, messageId: message.id, sessionId }),
      })).filter((item) => item.src)
    : [];
  const directiveContent = extractRemarkDirectives(inline.references.length ? inline.markdown : message.content);
  const renderedContent = renderFileCitationsAsMarkdown(directiveContent.markdown);
  const markdownContent = isUser ? renderedContent : normalizeMarkdownMath(renderedContent);
  const attachmentMedia = isUser
    ? (message.attachments || []).filter((attachment) => (
        attachment.kind === 'image' && (attachment.previewUrl || onResolveMedia)
      )).map((attachment) => ({
        id: `attachment-media-${attachment.id}`,
        attachmentId: attachment.id,
        kind: 'image',
        src: attachment.previewUrl,
        resourceId: attachment.resource?.id || attachment.id,
        alt: attachment.name,
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
      }))
    : [];
  const inlineMedia = [...(publishesMedia ? message.media || [] : [])];
  const inlineMediaAttachmentIds = new Set(inlineMedia.map((item) => item.attachmentId || item.id));
  for (const item of attachmentMedia) {
    if (!inlineMediaAttachmentIds.has(item.attachmentId)) inlineMedia.push(item);
  }
  const visibleAttachments = isUser
    ? (message.attachments || []).filter((attachment) => (
        !(attachment.kind === 'image' && (attachment.previewUrl || onResolveMedia))
        && (attachment.kind !== 'image' || !message.media?.length)
      ))
    : [];
  const defaultContent = <>
    {markdownContent ? (
      <SessionMarkdown
        components={markdownComponents}
        mode={isUser ? 'user' : 'default'}
      >{markdownContent}</SessionMarkdown>
    ) : null}
    {!markdownContent && !visualizations.length && !directiveContent.directives.length ? '…' : null}
  </>;
  const customContent = renderContent?.({
    content: markdownContent,
    defaultContent,
    message,
    session,
  });
  useEffect(() => {
    if (!isFinalResult || !onFinalResultVisible || typeof IntersectionObserver === 'undefined') return undefined;
    let intersecting = false;
    function notify() {
      if (!intersecting || finalResultReportedRef.current || document.visibilityState !== 'visible') return;
      finalResultReportedRef.current = true;
      onFinalResultVisible({
        sessionId,
        turnId: message.turnKey || message.turnId || null,
        messageId: message.id,
      });
    }
    const observer = new IntersectionObserver(([entry]) => {
      intersecting = Boolean(entry?.isIntersecting);
      notify();
    }, { threshold: 0.1 });
    observer.observe(messageRef.current);
    document.addEventListener('visibilitychange', notify);
    return () => {
      observer.disconnect();
      document.removeEventListener('visibilitychange', notify);
    };
  }, [isFinalResult, message.id, message.turnId, message.turnKey, onFinalResultVisible, sessionId]);

  async function saveEdit() {
    const prompt = editDraft.trim();
    if (!prompt || savingEdit || !canEdit) return;
    setSavingEdit(true);
    try {
      await onEditMessage({ messageId: message.id, turnId: message.turnId, prompt, references: message.references, attachments: message.attachments });
      setEditing(false);
    } finally {
      setSavingEdit(false);
    }
  }

  async function forkMessage() {
    if (forking || !canFork) return;
    setForking(true);
    try {
      await onForkMessage({ messageId: message.id, turnId: message.turnId, prompt: message.content, references: message.references });
    } finally {
      setForking(false);
    }
  }

  const messageContent = editing ? (
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
    <ScrollRegion className="cwu-message-body" bounded={isUser} ariaLabel={isUser ? '用户消息' : undefined}>
      {customContent === undefined ? defaultContent : customContent}
      {!isUser ? <RemarkDirectives directives={directiveContent.directives} onOpenLink={onOpenLink} /> : null}
    </ScrollRegion>
  );

  return (
    <agent-session-message className={`cwu-message ${isUser ? 'is-user' : isCommentary ? 'is-commentary' : 'is-assistant'} ${!isUser && message.turnStatus === 'inProgress' ? 'is-streaming' : ''} ${editing ? 'is-editing' : ''}`} data-message-id={message.id} ref={messageRef} phase={message.phase} role={message.role}>
      {isCommentary ? <div className="cwu-message-label">{message.label}</div> : null}
      {message.deliveryState ? <div className="cwu-message-label" role="status">{({ sending: '正在发送…', accepted: '已提交，等待同步…', unknown: '发送结果待确认，请重试确认' })[message.deliveryState]}</div> : null}
      {isUser && message.references?.length ? (
        <div aria-label="引用的 Sessions" className="cwu-message-references">
          {message.references.map((reference) => (
            <button
              className={reference.unavailable ? 'is-unavailable' : ''}
              disabled={reference.unavailable || !onOpenSessionReference}
              key={sessionReferenceKey(reference)}
              onClick={() => onOpenSessionReference?.(reference, message)}
              title={[reference.contextLabel, reference.unavailable ? '不可用' : '打开 Session'].filter(Boolean).join(' · ')}
              type="button"
            >
              <i aria-hidden="true">@</i>
              <span>{reference.label}</span>
              {reference.unavailable ? <small>不可用</small> : null}
            </button>
          ))}
        </div>
      ) : null}
      {messageContent}
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
      {inlineMedia.length ? (
        <MediaGallery
          items={inlineMedia}
          onOpenAttachment={onOpenAttachment}
          onResolveMedia={onResolveMedia}
          sessionId={sessionId}
        />
      ) : null}
      {visualizations.map((item) => (
        <div className={`cwu-inline-visualization${item.mode === 'wide' ? ' is-wide' : ''}`} key={item.path || item.file}>
          <iframe
            loading="lazy"
            referrerPolicy="no-referrer"
            sandbox="allow-scripts"
            src={item.src}
            title={item.title || item.file}
          />
          <a href={item.src} rel="noreferrer" target="_blank">在新窗口打开</a>
        </div>
      ))}
      {visibleAttachments.length ? (
        <div className="cwu-message-resource-group">
          <strong>{isUser ? '附件' : 'Agent 产物'}</strong>
          <div className="cwu-message-attachments" aria-label={isUser ? '附件' : 'Agent 产物'}>
            {visibleAttachments.map((attachment) => (
              <button
                className="cwu-message-attachment"
                disabled={!attachmentOpenable(attachment, onOpenAttachment)}
                key={attachment.id}
                onClick={() => onOpenAttachment?.(attachment, message)}
                title={attachmentOpenable(attachment, onOpenAttachment) ? `打开 ${attachment.name}` : attachment.name}
                type="button"
              >
                <i aria-hidden="true">{attachment.kind === 'image' ? '▧' : attachment.kind === 'audio' ? '♪' : attachment.kind === 'directory' ? '▱' : '▤'}</i>
                <span>{attachment.name}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {message.artifactErrors?.length ? (
        <div className="cwu-artifact-errors" role="status">
          {message.artifactErrors.map((failure, index) => (
            <span key={`${failure.name}-${index}`}>{failure.name} 未能归档</span>
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

function MediaGallery({ items, onOpenAttachment = null, onResolveMedia = null, sessionId = null }) {
  return (
    <div className="cwu-message-media" aria-label="消息图片">
      {items.map((item) => (
        <LazyMediaItem
          item={item}
          key={item.id}
          onOpenAttachment={onOpenAttachment}
          onResolveMedia={onResolveMedia}
          sessionId={sessionId}
        />
      ))}
    </div>
  );
}

function LazyMediaItem({ item, onOpenAttachment, onResolveMedia, sessionId }) {
  const rootRef = useRef(null);
  const requestRef = useRef(null);
  const [src, setSrc] = useState(item.src || '');
  const [state, setState] = useState(item.src ? 'ready' : 'idle');

  async function resolve({ open = false } = {}) {
    if (src) {
      if (open) openResolvedMedia(src);
      return src;
    }
    if (!onResolveMedia) return '';
    if (requestRef.current?.promise) {
      const pendingSrc = await requestRef.current.promise.catch(() => '');
      if (open && pendingSrc) openResolvedMedia(pendingSrc);
      return pendingSrc;
    }
    const controller = new AbortController();
    setState('loading');
    const pending = Promise.resolve(onResolveMedia(item, { sessionId, signal: controller.signal }));
    const request = { controller, promise: pending };
    requestRef.current = request;
    try {
      const resolved = await pending;
      if (controller.signal.aborted || !resolved) return '';
      setSrc(String(resolved));
      setState('ready');
      if (open) openResolvedMedia(String(resolved));
      return String(resolved);
    } catch (error) {
      if (error?.name !== 'AbortError') setState('error');
      return '';
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }

  function openResolvedMedia(resolvedSrc) {
    if (onOpenAttachment) {
      onOpenAttachment({
        id: item.attachmentId || item.resourceId || item.id,
        name: item.name,
        kind: 'image',
        mimeType: item.mimeType,
        size: item.size,
        previewUrl: resolvedSrc,
      });
    } else {
      globalThis.open?.(resolvedSrc, '_blank', 'noopener,noreferrer');
    }
  }

  useEffect(() => {
    requestRef.current?.controller?.abort();
    requestRef.current = null;
    setSrc(item.src || '');
    setState(item.src ? 'ready' : 'idle');
  }, [item.src, item.resourceId, item.attachmentId]);

  useEffect(() => {
    const target = rootRef.current;
    if (!target || src || !onResolveMedia || typeof IntersectionObserver !== 'function') return undefined;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      void resolve();
    }, { rootMargin: '240px' });
    observer.observe(target);
    return () => observer.disconnect();
  }, [src, onResolveMedia, item.resourceId, item.attachmentId, sessionId]);

  useEffect(() => () => requestRef.current?.controller?.abort(), []);

  return (
    <button
      aria-label={`${src ? '查看图片' : state === 'error' ? '重试图片' : '加载图片'}：${item.name}`}
      className={src ? '' : 'is-placeholder'}
      disabled={!src && !onResolveMedia}
      onClick={() => { if (src) openResolvedMedia(src); else void resolve({ open: true }); }}
      ref={rootRef}
      type="button"
    >
      {src
        ? <img alt={item.alt} loading="lazy" src={src} />
        : <span><strong>{item.name}</strong><small>{state === 'loading' ? '正在读取图片…' : state === 'error' ? '读取失败，点击重试' : '进入可视区域时读取'}</small></span>}
    </button>
  );
}

function TechnicalProcessItem({ item, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId }) {
  const [expanded, setExpanded] = useState(null);
  const panelId = `process-${sessionId}-${item.id}`;
  const typeLabels = { assistant: 'Codex', command: '运行命令', tool: '工具调用', plan: '执行计划', file: '文件变更' };
  function toggle(kind) { setExpanded(current => current === kind ? null : kind); }
  return <article className={`cwu-process-card type-${item.type}`}>
    <header>
      <strong>{item.label || typeLabels[item.type] || item.title}</strong>
      <div className="cwu-process-inline-actions">
        {item.detail ? <button type="button" aria-label={`查看详情：${item.title}`} aria-expanded={expanded === 'detail'} aria-controls={expanded === 'detail' ? panelId : undefined} onClick={() => toggle('detail')}>详情</button> : null}
        {item.output ? <button type="button" aria-label={`查看输出：${item.title}`} title={`${item.output.split('\n').length} 行输出`} aria-expanded={expanded === 'output'} aria-controls={expanded === 'output' ? panelId : undefined} onClick={() => toggle('output')}>输出</button> : null}
      </div>
    </header>
    {item.text ? item.type === 'command' ? <pre className="cwu-process-command">{item.text}</pre> : <div className="cwu-process-copy"><SessionMarkdown>{item.text}</SessionMarkdown></div> : <p className="cwu-process-copy">{item.title}</p>}
    {expanded ? <ScrollRegion className="cwu-process-detail" id={panelId} bounded ariaLabel={expanded === 'output' ? '命令或工具输出' : '调用详情'}><pre>{item[expanded]}</pre></ScrollRegion> : null}
    {item.media?.length ? <MediaGallery items={item.media} onResolveMedia={onResolveMedia} sessionId={sessionId}/> : null}
    {item.artifacts?.length ? <div className="cwu-technical-artifacts">{item.artifacts.map(artifact => <article key={artifact.id}><button disabled={!onOpenArtifact} type="button" onClick={() => onOpenArtifact?.(artifact, item)}><span><strong>{artifact.name}</strong><small>{artifact.status || '文件产物'}</small></span></button>{onRevealArtifact ? <button type="button" className="cwu-artifact-reveal" aria-label={`在文件夹中显示 ${artifact.name}`} onClick={() => onRevealArtifact(artifact, item)}><RevealFolderIcon/></button> : null}</article>)}</div> : null}
  </article>;
}

function TechnicalDetails({
  items, itemCount = null, available = false, loading = false, onLoad = null,
  onLoadItem = null,
  onOpenArtifact = null, onResolveMedia = null, onRevealArtifact = null,
  sessionId = null, startedAt = null, completedAt = null, running = false,
  turnStatus = null, manualOpen = null, onOpenChange = null, turnOrdinal = null, compactPresentation = false,
  progressive = false, loaded = false, detailTabs = null, manualTab = null, onTabChange = null,
}) {
  if (progressive) return <ProgressiveTechnicalDetails {...{ items, available, loaded, onLoad, onLoadItem, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId, running, turnStatus, manualOpen, onOpenChange, detailTabs, manualTab, onTabChange }} />;
  return <DefaultTechnicalDetails {...{ items, itemCount, available, loading, onLoad, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId, startedAt, completedAt, running, turnStatus, manualOpen, onOpenChange, turnOrdinal, compactPresentation }} />;
}

function DefaultTechnicalDetails({
  items, itemCount, available, loading, onLoad, onOpenArtifact, onResolveMedia, onRevealArtifact,
  sessionId, startedAt, completedAt, running, turnStatus, manualOpen, onOpenChange, turnOrdinal, compactPresentation,
}) {
  const open = manualOpen ?? running;
  const [durationNow, setDurationNow] = useState(() => Date.now());
  const count = Math.max(optionalInteger(itemCount, { minimum: 0 }) ?? 0, items.length);
  const ordinal = optionalInteger(turnOrdinal, { minimum: 1 });
  const duration = turnDurationLabel({ startedAt, completedAt, running, now: durationNow });
  const current = items.findLast(item => item.status === 'inProgress') || items.at(-1);
  useEffect(() => {
    if (!running || completedAt != null) return;
    const timer = globalThis.setInterval(() => setDurationNow(Date.now()), 1000);
    return () => globalThis.clearInterval(timer);
  }, [running, completedAt, startedAt]);
  async function toggle() {
    onOpenChange?.(!open);
    if (!open && available && onLoad && !loading) {
      try { await onLoad(); } catch { /* The Host owns the visible read error; retain the current record. */ }
    }
  }
  return <section className={`cwu-technical ${running ? 'is-running' : ''}`}>
    <button className="cwu-technical-toggle" type="button" aria-expanded={open} onClick={toggle}>
      {compactPresentation ? <span className="cwu-process-heading"><strong>{running ? '正在执行' : turnStatus === 'interrupted' ? '执行已中断' : '执行记录'}</strong><span>{current?.title || '公开执行过程'}</span></span> : <span>本轮执行详情</span>}
      <small>{[count ? `${count} 项` : '', ordinal ? `第 ${ordinal} 轮` : '', duration, loading && open ? '读取中…' : open ? '收起' : '展开'].filter(Boolean).join(' · ')}</small>
    </button>
    {open ? <ScrollRegion className="cwu-technical-list" bounded={!running} ariaLabel={running ? '当前公开执行过程' : '执行记录'}>
      {items.length ? items.map(item => <TechnicalProcessItem key={item.id} item={item} onOpenArtifact={onOpenArtifact} onResolveMedia={onResolveMedia} onRevealArtifact={onRevealArtifact} sessionId={sessionId}/>) : <p className="cwu-technical-loading">{loading ? '正在读取执行详情…' : '没有可展示的执行详情。'}</p>}
    </ScrollRegion> : null}
  </section>;
}

function ProgressiveTechnicalDetails({ items, available, loaded, onLoad, onLoadItem, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId, running, turnStatus, manualOpen, onOpenChange, detailTabs, manualTab, onTabChange }) {
  const panelId = useId();
  const [localOpen, setLocalOpen] = useState(false);
  const [localTab, setLocalTab] = useState('execution');
  const selectedTab = manualTab ?? localTab;
  const [expandedItems, setExpandedItems] = useState({});
  const [expandedGroups, setExpandedGroups] = useState({});
  const [read, setRead] = useState({ status: 'idle', error: '' });
  const [visibleCount, setVisibleCount] = useState(30);
  const [needsCompletionRefresh, setNeedsCompletionRefresh] = useState(false);
  const [itemDetails, setItemDetails] = useState({});
  const [itemReadState, setItemReadState] = useState({});
  const pending = useRef(null);
  const open = manualOpen ?? (running || localOpen);
  const tabbed = detailTabs != null;
  const activeTab = detailTabs?.find(tab => tab.id === selectedTab);
  const executionOpen = open && (!tabbed || !activeTab);
  const needsRead = available && onLoad && !running && (!loaded || needsCompletionRefresh) && read.status !== 'complete';
  const loadRef = useRef(onLoad);
  loadRef.current = onLoad;
  const mounted = useRef(true);
  const wasRunning = useRef(running);
  const runningRef = useRef(running);
  runningRef.current = running;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(() => {
    if (pending.current) return pending.current;
    setRead({ status: 'loading', error: '' });
    const task = Promise.resolve().then(() => loadRef.current?.()).then(result => {
      if (mounted.current) {
        const staleActiveRead = Boolean(result?.active && !runningRef.current);
        setRead({ status: staleActiveRead ? 'idle' : 'complete', error: '', items: result?.technicalItems || result?.items });
        setNeedsCompletionRefresh(staleActiveRead);
      }
    }).catch(error => {
      if (mounted.current) setRead({ status: 'error', error: error?.message || '执行记录暂时无法读取。' });
    }).finally(() => { if (pending.current === task) pending.current = null; });
    pending.current = task;
    return task;
  }, []);
  useEffect(() => {
    if (executionOpen && needsRead && !running && read.status === 'idle') void load();
  }, [executionOpen, needsRead, read.status, load]);
  useEffect(() => {
    if (wasRunning.current && !running && available && onLoad) {
      setRead({ status: 'idle', error: '' });
      setNeedsCompletionRefresh(true);
    }
    wasRunning.current = running;
  }, [running, available, onLoad]);
  const reading = needsRead && read.status === 'loading';
  const complete = !running && (loaded || read.status === 'complete');
  const summaryItems = read.items ? mergeTechnicalItems(items, read.items) : items;
  const allItems = summaryItems.map((item) => {
    const detail = itemDetails[item.id];
    return detail ? {
      ...detail,
      ...item,
      text: detail.text,
      detail: detail.detail,
      output: detail.output,
      media: detail.media,
      artifacts: detail.artifacts,
      previewTruncated: false,
      detailsAvailable: false,
    } : item;
  });
  const visibleItems = technicalItemsWindow(allItems, visibleCount);
  const error = (!loaded || needsCompletionRefresh) && read.status === 'error';
  const title = running ? '正在执行' : turnStatus === 'interrupted' ? '执行已中断' : '执行记录';
  async function loadItem(item) {
    if (!onLoadItem || itemReadState[item.id]?.status === 'loading') return;
    setItemReadState((current) => ({ ...current, [item.id]: { status: 'loading', error: '' } }));
    try {
      const result = await onLoadItem(item.id);
      if (!mounted.current) return;
      const technicalItem = result?.technicalItem || result?.item;
      if (!technicalItem) throw new Error('执行记录暂时无法读取。');
      setItemDetails((current) => ({ ...current, [item.id]: technicalItem }));
      setItemReadState((current) => ({ ...current, [item.id]: { status: 'complete', error: '', refreshOnOpen: Boolean(result?.active) } }));
    } catch (loadError) {
      if (!mounted.current) return;
      setItemReadState((current) => ({ ...current, [item.id]: { status: 'error', error: loadError?.message || '执行记录暂时无法读取。' } }));
    }
  }
  function setOpen(next) { setLocalOpen(next); onOpenChange?.(next); }
  function selectTab(id) {
    if (id === selectedTab && open) { setOpen(false); return; }
    setLocalTab(id); onTabChange?.(id); setOpen(true);
  }
  const tabs = [{ id: 'execution', label: '执行记录', count: complete ? allItems.length : null }, ...(detailTabs || [])];
  function onTabKey(event, index) {
    const target = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1
      : event.key === 'ArrowRight' ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : null;
    if (target == null) return;
    event.preventDefault();
    event.currentTarget.parentElement.querySelectorAll('[role="tab"]')[target]?.focus();
    selectTab(tabs[target].id);
  }
  const selectedId = activeTab?.id || 'execution';
  const statusLabel = running ? '执行中' : { completed: '已完成', interrupted: '已中断', failed: '已失败' }[turnStatus];
  return <section className={`cwu-technical is-progressive ${tabbed ? 'is-tabbed' : ''} ${running ? 'is-running' : ''}`} data-open={open}>
    {tabbed ? <header className="cwu-turn-detail-header" onClick={event => { if (!event.target.closest('button')) setOpen(!open); }}>
      <div className="cwu-turn-detail-tabs" role="tablist" aria-label="本轮详情">
        {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" id={`${panelId}-${tab.id}-tab`}
          aria-selected={selectedId === tab.id} aria-controls={`${panelId}-${tab.id}`} tabIndex={selectedId === tab.id ? 0 : -1}
          onKeyDown={event => onTabKey(event, index)} onClick={() => selectTab(tab.id)}>
          {tab.label}{tab.count != null ? <small>{tab.count}</small> : null}
        </button>)}
      </div>
      <div className="cwu-turn-detail-actions">{statusLabel ? <small>{statusLabel}</small> : null}
        <button className="cwu-turn-detail-toggle" type="button" aria-expanded={open} aria-label={open ? '收起本轮详情' : '展开本轮详情'} onClick={() => setOpen(!open)}>
          <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="m6 8 4 4 4-4"/></svg>
        </button>
      </div>
    </header> :
    <button className="cwu-technical-toggle" type="button" aria-expanded={open} aria-controls={panelId} onClick={() => { setLocalOpen(!open); onOpenChange?.(!open); }}>
      <span aria-hidden="true" className="cwu-process-chevron">{open ? '⌄' : '›'}</span><span>{title}</span>
    </button>}
    {open ? <div className={tabbed ? 'cwu-turn-detail-panel' : undefined} role={tabbed ? 'tabpanel' : undefined}
      id={tabbed ? `${panelId}-${selectedId}` : undefined} aria-labelledby={tabbed ? `${panelId}-${selectedId}-tab` : undefined}>
    {activeTab ? <ScrollRegion className="cwu-turn-detail-content" bounded={!running} ariaLabel={activeTab.label}>{activeTab.renderContent?.()}</ScrollRegion> :
    <ScrollRegion className={`cwu-progressive-list${running ? ' is-running' : ''}`} id={panelId} bounded ariaBusy={reading} ariaLabel={running ? '当前公开执行过程' : '执行记录'}>
      {reading ? <p className="cwu-technical-loading" role="status">正在读取执行记录…</p> : <>
        {error ? <div className="cwu-process-error" role="alert"><p>{read.error}</p><button type="button" onClick={() => void load()}>重试</button></div> : null}
        {running && available && onLoad && !loaded && read.status === 'idle' ? <button className="cwu-technical-load" type="button" onClick={() => { setVisibleCount((current) => current + 30); void load(); }}>加载更早记录</button> : null}
        {!tabbed && complete && allItems.length ? <p className="cwu-process-count">{allItems.length} 项执行记录</p> : null}
        {visibleCount < allItems.length ? <button className="cwu-technical-load" type="button" onClick={() => setVisibleCount((current) => current + 30)}>加载更早记录</button> : null}
        {technicalGroupsInWindow(allItems, visibleItems).map(entry => entry.kind === 'group'
          ? <TechnicalItemGroup key={entry.id} group={entry} open={Boolean(expandedGroups[entry.id])} onToggle={() => setExpandedGroups(current => ({ ...current, [entry.id]: !current[entry.id] }))} {...{ expandedItems, itemReadState, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId }} onLoadItem={onLoadItem ? item => void loadItem(item) : null} onToggleItem={item => setExpandedItems(current => ({ ...current, [item.id]: !current[item.id] }))} />
          : <ProgressiveProcessItem key={entry.item.id} item={entry.item} {...{ onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId }} expanded={Boolean(expandedItems[entry.item.id])} itemReadState={itemReadState[entry.item.id]} onLoadItem={onLoadItem ? () => void loadItem(entry.item) : null} onToggle={() => setExpandedItems(current => ({ ...current, [entry.item.id]: !current[entry.item.id] }))} />)}
        {!visibleItems.length && !error ? <p className="cwu-technical-loading">{running ? '等待执行进度…' : '没有可展示的执行记录。'}</p> : null}
      </>}
    </ScrollRegion>}
    </div> : null}
  </section>;
}

function TechnicalItemGroup({ group, open, onToggle, expandedItems, itemReadState, onLoadItem, onToggleItem, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId }) {
  const summary = technicalGroupSummary(group);
  const statusLabel = technicalStatusLabel(summary.status);
  return <section className={`cwu-process-group is-${summary.status || 'unknown'}`}>
    <button type="button" className="cwu-process-group-toggle" aria-expanded={open} onClick={onToggle}>
      <span aria-hidden="true" className="cwu-process-chevron">{open ? '⌄' : '›'}</span><span>{group.identity.startsWith('tool:') ? <><span className="cwu-tool-icon" aria-hidden="true">⌘</span>{summary.label}</> : summary.label}</span><small>{[`${summary.count} 项`, statusLabel].filter(Boolean).join(' · ')}</small>
    </button>
    {open ? <div className="cwu-process-group-items">{group.items.map(item => <ProgressiveProcessItem key={item.id} {...{ item, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId }} expanded={Boolean(expandedItems[item.id])} itemReadState={itemReadState[item.id]} onLoadItem={onLoadItem ? () => onLoadItem(item) : null} onToggle={() => onToggleItem(item)} />)}</div> : null}
  </section>;
}

function ProgressiveProcessItem({ item, expanded, onToggle, onLoadItem, itemReadState, onOpenArtifact, onResolveMedia, onRevealArtifact, sessionId }) {
  const panelId = useId();
  const summary = technicalProcessSummary(item);
  const hasContent = Boolean(item.text || item.detail || item.output || item.media?.length || item.artifacts?.length || item.detailsAvailable);
  const needsDisclosure = hasContent && (item.detailsAvailable || itemReadState?.refreshOnOpen || technicalProcessNeedsDisclosure(item));
  const simpleText = item.type !== 'subagent' && !needsDisclosure && item.text && !item.detail && !item.output && !item.media?.length && !item.artifacts?.length;
  const agentOperation = technicalSubagentOperationLabel(item.agentOperation, item.status);
  const row = <>{needsDisclosure ? <span className="cwu-process-chevron" aria-hidden="true">{expanded ? '⌄' : '›'}</span> : null}<span className="cwu-process-summary-text">{item.type === 'subagent' ? <><span className="cwu-subagent-icon" aria-hidden="true">◇</span>{summary.title}</> : item.type === 'tool' ? <><span className="cwu-tool-icon" aria-hidden="true">⌘</span>{summary.title}</> : summary.title}</span><small>{[summary.typeLabel, item.type === 'subagent' ? agentOperation : summary.statusLabel].filter(Boolean).join(' · ')}</small></>;
  return <article className={`cwu-process-row type-${item.type}`}>
    {simpleText ? <div className="cwu-process-inline-text"><div className="cwu-process-copy"><SessionMarkdown>{item.text}</SessionMarkdown></div>{summary.statusLabel ? <small>{summary.statusLabel}</small> : null}</div> : <>
    {needsDisclosure ? <button type="button" className="cwu-process-summary" aria-expanded={expanded} aria-controls={panelId} onClick={() => { onToggle(); if (!expanded && (item.detailsAvailable || itemReadState?.refreshOnOpen)) onLoadItem?.(); }}>{row}</button> : <div className="cwu-process-summary is-inline">{row}</div>}
    {itemReadState?.status === 'error' ? <div className="cwu-process-error" role="alert"><p>{itemReadState.error}</p><button type="button" onClick={onLoadItem}>重试</button></div> : null}
    {hasContent && (!needsDisclosure || expanded) ? <div className={`cwu-process-body${needsDisclosure ? '' : ' is-inline'}`} id={panelId}>
      {itemReadState?.status === 'loading' ? <p className="cwu-technical-loading" role="status">正在读取明细…</p> : null}
      {item.text ? item.type === 'command' ? <pre className="cwu-process-command">{item.text}</pre> : <div className="cwu-process-copy"><SessionMarkdown>{item.text}</SessionMarkdown></div> : null}
      {[['detail', '调用详情'], ['output', '输出']].map(([field, label]) => item[field] ? <section key={field}><h4>{label}</h4><ScrollRegion className="cwu-process-detail" bounded ariaLabel={label}><pre>{item[field]}</pre></ScrollRegion></section> : null)}
      {item.media?.length ? <MediaGallery items={item.media} onOpenAttachment={onOpenArtifact ? attachment => onOpenArtifact(attachment, item) : null} onResolveMedia={onResolveMedia} sessionId={sessionId} /> : null}
      {item.artifacts?.length ? <div className="cwu-technical-artifacts">{item.artifacts.map(artifact => <article key={artifact.id}><button disabled={!onOpenArtifact} type="button" onClick={() => onOpenArtifact?.(artifact, item)}><span><strong>{artifact.name}</strong><small>{artifact.status || '文件产物'}</small></span></button>{onRevealArtifact ? <button type="button" className="cwu-artifact-reveal" aria-label={`在文件夹中显示 ${artifact.name}`} onClick={() => onRevealArtifact(artifact, item)}><RevealFolderIcon /></button> : null}</article>)}</div> : null}
    </div> : null}
    </>}
  </article>;
}

function optionalInteger(value, { minimum }) {
  if (value == null || value === '') return null;
  const normalized = Number(value);
  return Number.isSafeInteger(normalized) && normalized >= minimum ? normalized : null;
}

function temporaryAttachmentId() {
  temporaryAttachmentSequence += 1;
  return `upload-${Date.now()}-${temporaryAttachmentSequence}`;
}

function attachmentProgressPercent(value) {
  const direct = typeof value === 'number' ? value : Number(value?.percent);
  if (Number.isFinite(direct)) return Math.min(100, Math.max(0, direct));
  const loaded = Number(value?.loaded);
  const total = Number(value?.total);
  return Number.isFinite(loaded) && Number.isFinite(total) && total > 0
    ? Math.min(100, Math.max(0, (loaded / total) * 100))
    : 0;
}

function formatAttachmentSize(value) {
  const size = Number(value);
  if (!Number.isFinite(size) || size <= 0) return '大小未知';
  if (size < 1024) return `${Math.round(size)} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function attachmentOpenable(attachment, onOpenAttachment) {
  if (typeof onOpenAttachment !== 'function') return false;
  const resource = attachment?.resource;
  if (resource?.mode !== 'external') return true;
  return resource.capabilities?.preview === true || resource.capabilities?.download === true;
}

function sandboxedHtmlSource(content) {
  const source = String(content || '');
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data: blob:; media-src data: blob:; font-src data:; style-src \'unsafe-inline\'; script-src \'unsafe-inline\'">';
  if (/<head(?:\s[^>]*)?>/i.test(source)) return source.replace(/<head(?:\s[^>]*)?>/i, (head) => `${head}${policy}`);
  if (/<html(?:\s[^>]*)?>/i.test(source)) return source.replace(/<html(?:\s[^>]*)?>/i, (html) => `${html}<head>${policy}</head>`);
  return `<!doctype html><html><head>${policy}</head><body>${source}</body></html>`;
}

function RuntimeProgress({ activityKind = null, activityLabel = '', plan }) {
  const label = activityLabel || (activityKind === 'contextCompaction' ? '整理上下文' : '正在处理');
  return (
    <section className="cwu-progress" aria-live="polite">
      <div className="cwu-progress-title"><i aria-hidden="true" />{label}</div>
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
  const elicitation = request.kind === 'mcpServer/elicitation/request';
  return (
    <section className="cwu-request">
      <div><strong>{request.title}</strong><p>{request.detail}</p></div>
      <div>
        <button className="cwu-button" onClick={() => onRespond({ token: request.token, decision: 'decline' })} type="button">拒绝</button>
        {!elicitation ? <button className="cwu-button" onClick={() => onRespond({ token: request.token, decision: 'acceptForSession' })} type="button">本 Session 允许</button> : null}
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
  normalizeCapabilityManagerViewModel,
  normalizeSessionBrowserViewModel,
  normalizeSessionViewModel,
  normalizeSideChatPanelViewModel,
  sessionStatusTone,
} from './model.js';

export { SessionApplication, useSessionHost } from './session-application.jsx';
export { SessionComposerUtilities } from './composer-utilities.jsx';
export { RealtimePanel as SessionRealtimePanel };
