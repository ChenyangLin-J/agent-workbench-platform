import {
  groupSessionSummaries as groupSharedSessionSummaries,
  sessionMessagePresentation,
  sessionStatusTone as sharedSessionStatusTone,
} from '../session.js';

export function normalizeSessionViewModel(value = {}) {
  return {
    sessionId: stringOrNull(value.sessionId),
    title: String(value.title || '未命名 Session'),
    contextLabel: String(value.contextLabel || 'Agent Session'),
    status: ['connecting', 'running', 'waiting', 'idle', 'error'].includes(value.status)
      ? value.status
      : 'idle',
    statusLabel: String(value.statusLabel || '空闲'),
    messages: Array.isArray(value.messages)
      ? value.messages.map((message, index) => ({
          ...sessionMessagePresentation(message),
          id: String(message?.id || `message-${index}`),
          content: String(message?.content || ''),
          turnId: stringOrNull(message?.turnId),
          attachments: Array.isArray(message?.attachments)
            ? message.attachments.map((attachment, attachmentIndex) => ({
                id: String(attachment?.id || `attachment-${index}-${attachmentIndex}`),
                name: String(attachment?.name || '附件'),
                kind: ['image', 'audio', 'file'].includes(attachment?.kind) ? attachment.kind : 'file',
              }))
            : [],
          media: normalizeMedia(message?.media, `message-${index}`),
        }))
      : [],
    plan: Array.isArray(value.plan)
      ? value.plan.map((step, index) => ({
          id: String(step?.id || `step-${index}`),
          text: String(step?.text || ''),
          status: String(step?.status || 'pending'),
        })).filter((step) => step.text)
      : [],
    technicalItems: Array.isArray(value.technicalItems)
      ? value.technicalItems.map((item, index) => ({
          id: String(item?.id || `technical-${index}`),
          title: String(item?.title || '执行步骤'),
          status: String(item?.status || ''),
          detail: String(item?.detail || ''),
          turnId: stringOrNull(item?.turnId),
          media: normalizeMedia(item?.media, `technical-${index}`),
        }))
      : [],
    pendingRequests: Array.isArray(value.pendingRequests)
      ? value.pendingRequests.map((request) => ({
          token: String(request?.token || ''),
          title: String(request?.title || '需要你的确认'),
          detail: String(request?.detail || ''),
          kind: String(request?.kind || 'approval'),
          questions: Array.isArray(request?.questions)
            ? request.questions.slice(0, 3).map((question, index) => ({
                id: String(question?.id || `question-${index}`),
                header: String(question?.header || ''),
                question: String(question?.question || ''),
                isSecret: Boolean(question?.isSecret),
                options: Array.isArray(question?.options)
                  ? question.options.map((option) => ({
                      label: String(option?.label || ''),
                      description: String(option?.description || ''),
                    })).filter((option) => option.label)
                  : [],
              })).filter((question) => question.id && question.question)
            : [],
        })).filter((request) => request.token)
      : [],
    subagents: Array.isArray(value.subagents)
      ? value.subagents.map((agent, index) => ({
          id: String(agent?.id || `subagent-${index}`),
          name: String(agent?.name || '子 Agent'),
          nickname: String(agent?.nickname || ''),
          role: String(agent?.role || ''),
          status: String(agent?.status || '未知'),
          statusType: String(agent?.statusType || 'unknown'),
          state: String(agent?.state || ''),
          stateMessage: String(agent?.stateMessage || ''),
          prompt: String(agent?.prompt || ''),
          model: String(agent?.model || ''),
          reasoningEffort: String(agent?.reasoningEffort || ''),
          canStop: Boolean(agent?.canStop),
          updatedAt: normalizeTimestamp(agent?.updatedAt),
        })).filter((agent) => agent.id)
      : [],
    executionProfile: String(value.executionProfile || ''),
    queuedTurns: Array.isArray(value.queuedTurns)
      ? value.queuedTurns.map((item, index) => ({
          id: String(item?.id || `queued-turn-${index}`),
          prompt: String(item?.prompt || ''),
          attachments: Array.isArray(item?.attachments)
            ? item.attachments.map((attachment, attachmentIndex) => ({
                id: String(attachment?.id || `queued-attachment-${index}-${attachmentIndex}`),
                name: String(attachment?.name || '附件'),
              }))
            : [],
          createdAt: normalizeTimestamp(item?.createdAt),
        }))
      : [],
    hasEarlierTurns: Boolean(value.hasEarlierTurns),
    historyLoading: Boolean(value.historyLoading),
    loadedTurnCount: Number.isFinite(Number(value.loadedTurnCount))
      ? Math.max(0, Number(value.loadedTurnCount))
      : null,
    externalUrl: stringOrNull(value.externalUrl),
  };
}

export function extractInlineVisualizations(content = '') {
  const files = [];
  const markdown = String(content).replace(
    /^[ \t]*::codex-inline-vis\{file="([a-z0-9](?:[a-z0-9-]{0,126})\.html)"\}[ \t]*$/gim,
    (_, file) => {
      files.push(file);
      return '';
    },
  ).replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, files };
}

function normalizeMedia(value, fallbackPrefix) {
  return Array.isArray(value)
    ? value.map((media, index) => ({
        id: String(media?.id || `${fallbackPrefix}-media-${index}`),
        kind: media?.kind === 'image' ? 'image' : 'file',
        src: String(media?.src || ''),
        alt: String(media?.alt || media?.name || '图片'),
      })).filter((media) => media.kind === 'image' && media.src)
    : [];
}

export function normalizeSessionBrowserViewModel(value = {}) {
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map((session, index) => ({
        id: String(session?.id || `session-${index}`),
        title: String(session?.title || '未命名 Session'),
        contextId: stringOrNull(session?.contextId),
        contextLabel: String(session?.contextLabel || '未分类'),
        updatedAt: normalizeTimestamp(session?.updatedAt ?? session?.createdAt),
        completedAt: normalizeTimestamp(session?.completedAt),
        status: ['connecting', 'running', 'waiting', 'unread', 'idle', 'error'].includes(session?.status)
          ? session.status
          : 'idle',
        statusLabel: String(session?.statusLabel || ''),
        archived: Boolean(session?.archived),
        canArchive: session?.canArchive !== false,
      }))
    : [];
  sessions.sort((left, right) => right.updatedAt - left.updatedAt || left.title.localeCompare(right.title));
  return {
    sessions,
    selectedSessionId: stringOrNull(value.selectedSessionId),
    groupMode: value.groupMode === 'time' ? 'time' : 'context',
    loading: Boolean(value.loading),
    listCollapsed: Boolean(value.listCollapsed),
    archived: Boolean(value.archived),
    createTargets: Array.isArray(value.createTargets)
      ? value.createTargets.map((target, index) => ({
          id: String(target?.id || `target-${index}`),
          label: String(target?.label || '未命名'),
        })).filter((target) => target.id)
      : [],
  };
}

export function groupSessionSummaries(sessions, mode = 'context', now = Date.now()) {
  return groupSharedSessionSummaries(sessions, mode, now);
}

export function sessionStatusTone(status) {
  return sharedSessionStatusTone(status);
}

export function newlyCompletedSessions(previousCompletionTimes, sessions, now = Date.now()) {
  return (sessions || []).filter((session) => (
    session.completedAt > (previousCompletionTimes?.get(session.id) || 0)
    && now - session.completedAt >= 0
    && now - session.completedAt < 6000
  ));
}

function stringOrNull(value) {
  const normalized = value == null ? '' : String(value).trim();
  return normalized || null;
}

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}
