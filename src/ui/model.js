import {
  groupSessionSummaries as groupSharedSessionSummaries,
  sessionMessagePresentation,
  sessionStatusTone as sharedSessionStatusTone,
} from '../session.js';
import { normalizeSessionAttachment } from '../attachments.js';
import TurndownService from 'turndown';
import { gfm as turndownGfm } from 'turndown-plugin-gfm';

const richTextTurndown = new TurndownService({
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  headingStyle: 'atx',
  strongDelimiter: '**',
});
richTextTurndown.use(turndownGfm);
richTextTurndown.addRule('styledStrong', {
  filter: (node) => node.nodeName === 'SPAN' && /(?:bold|[6-9]00)/i.test(node.style?.fontWeight || ''),
  replacement: (content) => content.trim() ? `**${content}**` : content,
});
richTextTurndown.addRule('bodyOnlyTable', {
  filter: (node) => node.nodeName === 'TABLE'
    && (!node.rows?.[0] || [...node.rows[0].cells].some((cell) => cell.nodeName !== 'TH')),
  replacement: (content) => {
    const visibleRows = String(content || '').replace(/\n{2,}/g, '\n').trim();
    return visibleRows ? `\n\n${visibleRows}\n\n` : '';
  },
});
richTextTurndown.addRule('hiddenClipboardContent', {
  filter: (node) => node.nodeType === 1 && (
    node.hasAttribute?.('hidden')
    || node.getAttribute?.('aria-hidden') === 'true'
    || /(?:display\s*:\s*none|visibility\s*:\s*hidden)/i.test(node.getAttribute?.('style') || '')
  ),
  replacement: () => '',
});
richTextTurndown.remove(['script', 'style', 'noscript', 'template', 'svg', 'iframe', 'object']);

export function isLocalFileHref(value) {
  const href = String(value ?? '').trim();
  return (href.startsWith('/') && !href.startsWith('//'))
    || /^\.\.?[\\/]/.test(href)
    || /^[a-z]:[\\/]/i.test(href)
    || /^file:\/\//i.test(href);
}

export function localFileBrowserHref(value) {
  const href = String(value ?? '').trim();
  if (!isLocalFileHref(href) || /^file:\/\//i.test(href)) return href;
  if (/^\.\.?[\\/]/.test(href)) return href;
  if (/^[a-z]:[\\/]/i.test(href)) return `file:///${href.replace(/\\/g, '/')}`;
  return `file://${href}`;
}

export function attachmentDragLeavesTarget({
  currentTarget,
  relatedTarget,
  clientX,
  clientY,
} = {}) {
  if (!currentTarget) return true;
  if (relatedTarget && currentTarget.contains?.(relatedTarget)) return false;
  const bounds = currentTarget.getBoundingClientRect?.();
  const hasPointerPosition = Number.isFinite(clientX)
    && Number.isFinite(clientY)
    && (clientX !== 0 || clientY !== 0);
  const remainsInside = bounds
    && hasPointerPosition
    && clientX >= bounds.left
    && clientX <= bounds.right
    && clientY >= bounds.top
    && clientY <= bounds.bottom;
  return !remainsInside;
}

export function dataTransferHasFiles(dataTransfer) {
  return Array.from(dataTransfer?.types || []).includes('Files');
}

export function isDocumentResourceHref(value) {
  const href = String(value ?? '').trim();
  if (!href || href.startsWith('#') || href.startsWith('//')) return false;
  if (/^(?:https?:|data:|blob:|mailto:|tel:|codex:)/i.test(href)) return false;
  return isLocalFileHref(href) || !/^[a-z][a-z\d+.-]*:/i.test(href);
}

export function resolveDocumentResourceHref(file = {}, value = '', resolver = null) {
  const href = String(value ?? '').trim();
  if (!isDocumentResourceHref(href) || typeof resolver !== 'function') return href;
  const resolved = resolver({ file, href });
  return resolved ? String(resolved) : href;
}

export function markdownHeadingId(value = '') {
  return String(value)
    .trim()
    .toLocaleLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s_-]/gu, '')
    .replace(/[\s_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'section';
}

const CODE_PREVIEW_EXTENSIONS = new Set([
  'bash', 'c', 'cc', 'cjs', 'cpp', 'cs', 'css', 'go', 'h', 'hpp', 'html', 'java', 'js', 'json', 'jsonl',
  'jsx', 'kt', 'kts', 'mjs', 'php', 'py', 'rb', 'rs', 'scss', 'sh', 'sql', 'sqlx', 'swift', 'toml', 'ts',
  'tsx', 'xml', 'yaml', 'yml', 'zsh',
]);

export function documentPreviewPresentation(file = {}) {
  const name = String(file.name || 'file');
  const format = String(file.format || '').toLowerCase();
  const extension = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const content = String(file.content || '');
  const lines = content.split('\n');
  const explicitLine = Number(file.highlightLine ?? file.line);
  const referencedLine = [file.reference, file.href, file.path]
    .map((value) => String(value || '').match(/(?:#L|:)(\d+)(?:C\d+|:\d+)?$/i)?.[1])
    .find(Boolean);
  const candidateLine = Number.isInteger(explicitLine) && explicitLine > 0
    ? explicitLine
    : Number(referencedLine || 0);
  const highlightLine = candidateLine > 0 && candidateLine <= lines.length ? candidateLine : null;
  return {
    code: format === 'code' || format === 'sql' || (format === 'text' && CODE_PREVIEW_EXTENSIONS.has(extension)),
    highlightLine,
    lines,
  };
}

export function normalizeSessionViewModel(value = {}) {
  const models = normalizeModelOptions(value.models);
  const rawExecutionProfile = value.executionProfile;
  const executionProfile = typeof rawExecutionProfile === 'object' && rawExecutionProfile
    ? {
        model: String(rawExecutionProfile.model || models.find((model) => model.isDefault)?.id || models[0]?.id || ''),
        reasoningEffort: String(rawExecutionProfile.reasoningEffort || ''),
        accessMode: ['full', 'restricted'].includes(rawExecutionProfile.accessMode)
          ? rawExecutionProfile.accessMode
          : 'restricted',
        serviceTier: rawExecutionProfile.serviceTier ? String(rawExecutionProfile.serviceTier) : null,
        label: String(rawExecutionProfile.label || ''),
      }
    : {
        model: models.find((model) => model.isDefault)?.id || models[0]?.id || '',
        reasoningEffort: '',
        accessMode: 'restricted',
        serviceTier: null,
        label: String(rawExecutionProfile || ''),
      };
  const selectedModel = models.find((model) => model.id === executionProfile.model);
  if (!executionProfile.reasoningEffort) {
    executionProfile.reasoningEffort = selectedModel?.defaultReasoningEffort || 'medium';
  }
  return {
    sessionId: stringOrNull(value.sessionId),
    isDraft: Boolean(value.isDraft),
    draft: String(value.draft || ''),
    composerDisabled: Boolean(value.composerDisabled),
    title: String(value.title || '未命名 Session'),
    contextLabel: value.contextLabel == null ? 'Agent Session' : String(value.contextLabel),
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
          turnStatus: stringOrNull(message?.turnStatus),
          canEdit: Boolean(message?.canEdit),
          canFork: Boolean(message?.canFork),
          attachments: Array.isArray(message?.attachments)
            ? message.attachments.map((attachment, attachmentIndex) => ({
                ...normalizeSessionAttachment(attachment, `attachment-${index}-${attachmentIndex}`),
                sourceKind: String(attachment?.sourceKind || ''),
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
          artifacts: normalizeTechnicalArtifacts(item?.artifacts, `technical-${index}`),
        }))
      : [],
    technicalDetailsAvailable: Array.isArray(value.technicalDetailsAvailable)
      ? [...new Set(value.technicalDetailsAvailable.map((turnId) => String(turnId || '')).filter(Boolean))]
      : [],
    technicalDetailsLoading: Boolean(value.technicalDetailsLoading),
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
    executionProfile,
    models,
    accessModes: Array.isArray(value.accessModes) && value.accessModes.length
      ? value.accessModes.map((mode) => ({
          id: ['full', 'restricted'].includes(mode?.id) ? mode.id : String(mode?.id || ''),
          label: String(mode?.label || mode?.id || ''),
        })).filter((mode) => mode.id && mode.label)
      : [
          { id: 'full', label: '完全访问' },
          { id: 'restricted', label: '受限访问' },
        ],
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

export function groupSessionMessages(messages = []) {
  const entries = [];
  for (const message of messages) {
    const completedCommentary = message?.phase === 'commentary'
      && ['completed', 'failed', 'interrupted', 'cancelled', 'canceled'].includes(message?.turnStatus);
    const previous = entries.at(-1);
    if (completedCommentary && previous?.kind === 'commentary-group' && previous.turnId === message.turnId) {
      previous.messages.push(message);
      continue;
    }
    if (completedCommentary) {
      entries.push({
        kind: 'commentary-group',
        id: `commentary-group-${message.turnId || 'unassigned'}-${message.id}`,
        turnId: message.turnId,
        messages: [message],
      });
      continue;
    }
    entries.push({ kind: 'message', id: message.id, message });
  }
  return entries;
}

function mapMarkdownLinesOutsideCode(content, transform) {
  let fence = null;
  return String(content).split(/\r?\n/).map((line) => {
    const fenceMatch = line.match(/^[ ]{0,3}(`{3,}|~{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length };
      } else if (
        marker === fence.marker
        && fenceMatch[1].length >= fence.length
        && /^[ ]{0,3}(?:`{3,}|~{3,})[ \t]*$/.test(line)
      ) {
        fence = null;
      }
      return line;
    }
    if (fence || /^(?: {4}|\t)/.test(line)) return line;
    return transform(line);
  }).join('\n');
}

function safeVisualizationFile(value) {
  const file = String(value || '').split(/[\\/]/).filter(Boolean).at(-1) || '';
  return /^[a-z0-9](?:[a-z0-9-]{0,126})\.html$/i.test(file) ? file : null;
}

export function extractVisualizationReferences(content = '') {
  const references = [];
  const markdown = mapMarkdownLinesOutsideCode(content, (line) => {
    const legacy = line.match(/^[ \t]*::codex-inline-vis\{file="([a-z0-9](?:[a-z0-9-]{0,126})\.html)"\}[ \t]*$/i);
    if (legacy) {
      references.push({ file: legacy[1], path: null, mode: null, title: null });
      return '';
    }

    const current = line.match(/^[ \t]*visualize(\{.*\})[ \t]*$/u);
    if (!current) return line;
    try {
      const value = JSON.parse(current[1]);
      const file = safeVisualizationFile(value?.path);
      if (!file) return line;
      references.push({
        file,
        path: String(value.path),
        mode: value.mode === 'wide' ? 'wide' : null,
        title: typeof value.title === 'string' && value.title.trim() ? value.title.trim().slice(0, 250) : null,
      });
      return '';
    } catch {
      return line;
    }
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, references };
}

export function extractInlineVisualizations(content = '') {
  const { markdown, references } = extractVisualizationReferences(content);
  return { markdown, files: references.map((reference) => reference.file) };
}

export function normalizeMarkdownMath(content = '') {
  return mapMarkdownLinesOutsideCode(content, (line) => {
    if (/^[ \t]*\\\[[ \t]*$/.test(line)) return `${line.match(/^[ \t]*/)[0]}$$`;
    if (/^[ \t]*\\\][ \t]*$/.test(line)) return `${line.match(/^[ \t]*/)[0]}$$`;
    return line.split(/(`+[^`]*`+)/g).map((segment) => (
      segment.startsWith('`')
        ? segment
        : segment.replace(/\\\(/g, () => '$$').replace(/\\\)/g, () => '$$')
    )).join('');
  });
}

export function renderFileCitationsAsMarkdown(content = '') {
  return String(content).replace(
    /:codex-file-citation\{path="([^"]+)"(?:\s+purpose="[^"]+")?(?:\s+[^}]*)?\}/g,
    (_, filePath) => {
      const name = filePath.split('/').filter(Boolean).pop() || '文件';
      const safeName = name.replace(/[\[\]]/g, '\\$&');
      const safePath = filePath.replace(/[()]/g, '\\$&').replace(/ /g, '%20');
      return `[文件：${safeName}](${safePath})`;
    },
  );
}

export function extractRemarkDirectives(content = '') {
  const directives = [];
  const markdown = mapMarkdownLinesOutsideCode(content, (line) => {
    const directive = line.match(/^[ \t]*::([a-z][a-z0-9-]*)\{([^\n}]*)\}[ \t]*$/i);
    if (!directive || directive[1].toLowerCase() === 'codex-inline-vis') return line;
    const attributes = {};
    for (const match of directive[2].matchAll(/([a-zA-Z][a-zA-Z0-9_-]*)=(?:"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|([^\s]+))/g)) {
      const value = match[2] ?? match[3] ?? match[4] ?? '';
      attributes[match[1]] = value.replace(/\\([\\"'])/g, '$1');
    }
    directives.push({ name: directive[1].toLowerCase(), attributes });
    return '';
  }).replace(/\n{3,}/g, '\n\n').trim();
  return { markdown, directives };
}

function normalizeMedia(value, fallbackPrefix) {
  return Array.isArray(value)
    ? value.map((media, index) => ({
        id: String(media?.id || `${fallbackPrefix}-media-${index}`),
        kind: media?.kind === 'image' ? 'image' : 'file',
        src: String(media?.src || ''),
        alt: String(media?.alt || media?.name || '图片'),
        name: String(media?.name || media?.alt || '图片'),
        attachmentId: media?.attachmentId ? String(media.attachmentId) : '',
        mimeType: String(media?.mimeType || 'image/*').toLowerCase(),
        size: Number.isFinite(Number(media?.size)) ? Number(media.size) : 0,
      })).filter((media) => media.kind === 'image' && media.src)
    : [];
}

export function normalizeSessionBrowserViewModel(value = {}) {
  const sessions = Array.isArray(value.sessions)
    ? value.sessions.map((session, index) => ({
        id: String(session?.id || `session-${index}`),
        title: String(session?.title || '未命名 Session'),
        contextId: stringOrNull(session?.contextId),
        contextLabel: session?.contextLabel == null ? '未分类' : String(session.contextLabel),
        secondaryLabel: String(session?.secondaryLabel || ''),
        accessKind: session?.access?.kind === 'shared'
          ? 'shared'
          : session?.access?.kind === 'owned' ? 'owned' : null,
        searchableText: String(session?.searchableText || session?.searchText || ''),
        groupSortOrder: Number.isFinite(Number(session?.groupSortOrder)) ? Number(session.groupSortOrder) : null,
        sortOrder: Number.isFinite(Number(session?.sortOrder)) ? Number(session.sortOrder) : null,
        updatedAt: normalizeTimestamp(session?.updatedAt ?? session?.createdAt),
        completedAt: normalizeTimestamp(session?.completedAt),
        status: [
          'attention', 'connecting', 'error', 'idle', 'interrupted', 'released',
          'restoring', 'running', 'stopping', 'unread', 'waiting',
        ].includes(session?.status)
          ? session.status
          : 'idle',
        statusLabel: String(session?.statusLabel || ''),
        groupKind: ['attention', 'error', 'ready', 'released', 'running', 'unread'].includes(session?.groupKind)
          ? session.groupKind
          : null,
        archived: Boolean(session?.archived),
        canArchive: session?.canArchive !== false,
        canEnd: Boolean(session?.canEnd),
        favorited: Boolean(session?.favorited),
        canFavorite: session?.canFavorite !== false,
      }))
    : [];
  sessions.sort((left, right) => {
    if (left.sortOrder != null || right.sortOrder != null) {
      const orderDelta = (left.sortOrder ?? Number.MAX_SAFE_INTEGER) - (right.sortOrder ?? Number.MAX_SAFE_INTEGER);
      if (orderDelta) return orderDelta;
    }
    return right.updatedAt - left.updatedAt || left.title.localeCompare(right.title);
  });
  const defaultGroupOptions = [
    { id: 'context', label: '按归属' },
    { id: 'time', label: '按时间' },
  ];
  const groupOptions = Array.isArray(value.groupOptions)
    ? value.groupOptions.map((option) => {
        const id = typeof option === 'string' ? option : option?.id;
        if (!['attention', 'context', 'time'].includes(id)) return null;
        const defaultLabel = id === 'attention' ? '按状态' : id === 'time' ? '按时间' : '按归属';
        return { id, label: String(option?.label || defaultLabel) };
      }).filter(Boolean)
    : defaultGroupOptions;
  const requestedGroupMode = ['attention', 'context', 'time'].includes(value.groupMode)
    ? value.groupMode
    : 'context';
  return {
    sessions,
    selectedSessionId: stringOrNull(value.selectedSessionId),
    groupMode: requestedGroupMode,
    groupOptions,
    loading: Boolean(value.loading),
    loadingMore: Boolean(value.loadingMore),
    hasMore: Boolean(value.hasMore),
    paginationMode: ['complete', 'incremental'].includes(value.paginationMode)
      ? value.paginationMode
      : requestedGroupMode === 'time' ? 'incremental' : 'complete',
    listCollapsed: Boolean(value.listCollapsed),
    archived: Boolean(value.archived),
    showCreateTargetSelect: value.showCreateTargetSelect !== false,
    createTargets: Array.isArray(value.createTargets)
      ? value.createTargets.map((target, index) => ({
          id: String(target?.id || `target-${index}`),
          label: String(target?.label || '未命名'),
        })).filter((target) => target.id)
      : [],
  };
}

export function normalizeCapabilityManagerViewModel(value = {}) {
  const capabilities = Array.isArray(value.capabilities) ? value.capabilities.map((item, index) => ({
    id: String(item?.id || `capability-${index}`),
    title: String(item?.title || item?.id || 'Capability'),
    kind: ['skill-source', 'mcp-server', 'cli-tool', 'credential-provider'].includes(item?.kind)
      ? item.kind
      : 'skill-source',
    kindLabel: String(item?.kindLabel || ({
      'skill-source': 'Skills', 'mcp-server': 'MCP', 'cli-tool': 'CLI', 'credential-provider': 'Credentials',
    })[item?.kind] || item?.kind || 'Capabilities'),
    scope: item?.scope === 'custom' ? 'custom' : 'common',
    version: String(item?.version || ''),
    enabled: Boolean(item?.enabled),
    available: Boolean(item?.available),
    status: String(item?.status || (item?.enabled ? 'degraded' : 'disabled')),
    detail: item?.detail == null ? '' : String(item.detail),
    dependencies: stringList(item?.dependencies),
    requiredBy: stringList(item?.requiredBy),
    components: stringList(item?.components),
    action: normalizeCapabilityAction(item?.action),
  })) : [];
  const enabled = capabilities.filter((item) => item.enabled).length;
  return {
    profileId: String(value.profileId || 'default'),
    catalogVersion: Number(value.catalogVersion) || 1,
    counts: {
      common: Number(value.counts?.common ?? capabilities.filter((item) => item.scope === 'common').length),
      custom: Number(value.counts?.custom ?? capabilities.filter((item) => item.scope === 'custom').length),
      enabled: Number(value.counts?.enabled ?? enabled),
      healthy: Number(value.counts?.healthy ?? capabilities.filter((item) => item.enabled && item.available).length),
    },
    capabilities,
  };
}

function normalizeCapabilityAction(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    status: String(value.status || ''),
    operation: String(value.operation || ''),
    title: String(value.title || ''),
    detail: String(value.detail || ''),
    confirmationRequired: Boolean(value.confirmationRequired),
    instructions: stringList(value.metadata?.instructions),
  };
}

function stringList(value) {
  return Array.isArray(value) ? [...new Set(value.map(String).filter(Boolean))] : [];
}

export function normalizeSideChatPanelViewModel(value = {}) {
  const sideChats = Array.isArray(value.sideChats)
    ? value.sideChats.map((sideChat, index) => ({
        id: String(sideChat?.id || `side-chat-${index}`),
        title: String(sideChat?.title || `Side chat${index ? ` ${index + 1}` : ''}`),
        status: ['creating', 'idle', 'running', 'interrupted', 'expired', 'error'].includes(sideChat?.status)
          ? sideChat.status
          : 'idle',
        resumable: sideChat?.resumable !== false && sideChat?.status !== 'expired',
        selectedText: String(sideChat?.selectedText || ''),
        model: String(sideChat?.model || ''),
        reasoningEffort: String(sideChat?.reasoningEffort || ''),
        transcript: Array.isArray(sideChat?.transcript)
          ? sideChat.transcript.map((message, messageIndex) => ({
              id: String(message?.id || `side-chat-${index}-message-${messageIndex}`),
              role: ['user', 'assistant', 'notice'].includes(message?.role) ? message.role : 'notice',
              content: String(message?.content ?? message?.text ?? ''),
            })).filter((message) => message.content)
          : [],
        createdAt: normalizeTimestamp(sideChat?.createdAt),
      }))
    : [];
  const selectedId = stringOrNull(value.selectedId);
  const selected = sideChats.find((sideChat) => sideChat.id === selectedId) || null;
  const models = normalizeModelOptions(value.models);
  return { sideChats, selectedId: selected?.id || null, selected, models };
}

function normalizeModelOptions(value) {
  return Array.isArray(value)
    ? value.map((model, index) => ({
        id: String(model?.model || model?.id || `model-${index}`),
        label: String(model?.displayName || model?.label || model?.model || model?.id || `Model ${index + 1}`),
        isDefault: Boolean(model?.isDefault),
        defaultReasoningEffort: String(model?.defaultReasoningEffort || 'medium'),
        defaultServiceTier: model?.defaultServiceTier ? String(model.defaultServiceTier) : null,
        serviceTiers: Array.isArray(model?.serviceTiers)
          ? model.serviceTiers.map((tier) => ({
              id: String(tier?.id || tier || ''),
              label: String(tier?.name || tier?.label || tier?.id || tier || ''),
              description: String(tier?.description || ''),
            })).filter((tier) => tier.id)
          : [],
        reasoningEfforts: Array.isArray(model?.supportedReasoningEfforts) && model.supportedReasoningEfforts.length
          ? model.supportedReasoningEfforts.map((effort) => String(effort?.reasoningEffort || effort)).filter(Boolean)
          : Array.isArray(model?.reasoningEfforts) && model.reasoningEfforts.length
            ? model.reasoningEfforts.map(String).filter(Boolean)
            : ['low', 'medium', 'high', 'xhigh'],
      }))
    : [];
}

function normalizeTechnicalArtifacts(value, fallbackId) {
  return Array.isArray(value)
    ? value.map((artifact, index) => ({
        id: String(artifact?.id || `${fallbackId}-artifact-${index}`),
        name: String(artifact?.name || artifact?.path || '文件产物'),
        kind: ['image', 'audio', 'file'].includes(artifact?.kind) ? artifact.kind : 'file',
        mimeType: String(artifact?.mimeType || 'application/octet-stream').toLowerCase(),
        size: Number.isFinite(Number(artifact?.size)) ? Math.max(0, Number(artifact.size)) : 0,
        status: String(artifact?.status || ''),
        path: String(artifact?.path || ''),
        href: String(artifact?.href || ''),
        previewUrl: String(artifact?.previewUrl || ''),
      })).filter((artifact) => artifact.name)
    : [];
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

export function clipboardAttachmentFiles(clipboardData) {
  const directFiles = [...(clipboardData?.files || [])];
  const candidates = directFiles.length
    ? directFiles
    : [...(clipboardData?.items || [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile?.())
      .filter(Boolean);
  const seen = new Set();
  return candidates.filter((file) => {
    const signature = [file.name, file.type, file.size, file.lastModified].join(':');
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

export function richClipboardHasComplexStructure(value, html = '') {
  const content = String(value || '');
  if (!content.trim()) return false;
  const source = String(html || '');
  if (/<(?:h[1-6]|ul|ol|li|table|thead|tbody|tr|pre|blockquote)\b/i.test(source)) return true;
  if ((source.match(/<(?:p|div)\b/gi) || []).length > 1) return true;
  return /(^|\n)\s{0,3}(?:#{1,6}\s+|>\s+|[-+*]\s+|\d+[.)]\s+|```|~~~|\|.+\|\s*$)/m.test(content)
    || /\n\s*\n/.test(content);
}

function transferItems(dataTransfer) {
  try {
    return [...(dataTransfer?.items || [])];
  } catch {
    return [];
  }
}

function transferItemEntry(item) {
  try {
    return item?.webkitGetAsEntry?.() || null;
  } catch {
    return null;
  }
}

function transferItemFile(item) {
  try {
    return item?.getAsFile?.() || null;
  } catch {
    return null;
  }
}

function transferText(dataTransfer, type) {
  try {
    return String(dataTransfer?.getData?.(type) || '');
  } catch {
    return '';
  }
}

function decodeFileUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'file:') return '';
    const pathname = decodeURIComponent(url.pathname);
    return url.hostname && url.hostname !== 'localhost' ? `//${url.hostname}${pathname}` : pathname;
  } catch {
    return '';
  }
}

function isAbsolutePathHint(value) {
  return value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || value.startsWith('\\\\');
}

function transferPathHints(dataTransfer) {
  const lines = [
    ...transferText(dataTransfer, 'text/uri-list').split(/\r?\n/),
    ...transferText(dataTransfer, 'text/plain').split(/\r?\n/),
  ];
  const hints = [];
  for (const line of lines) {
    const value = line.trim();
    if (!value || value.startsWith('#')) continue;
    const hint = value.startsWith('file:') ? decodeFileUrl(value) : value;
    if (hint && isAbsolutePathHint(hint) && !hints.includes(hint)) hints.push(hint);
  }
  return hints;
}

function pathHintBasename(value) {
  return String(value || '').replace(/[\\/]+$/, '').split(/[\\/]/).at(-1) || '';
}

export function composerDropPayload(dataTransfer) {
  const items = transferItems(dataTransfer).filter((item) => !item?.kind || item.kind === 'file');
  const directFiles = [...(dataTransfer?.files || [])];
  if (!items.length) {
    return { directories: [], files: directFiles };
  }
  const pathHints = transferPathHints(dataTransfer);
  const directoryCandidates = [];
  const files = [];
  for (const item of items) {
    const entry = transferItemEntry(item);
    const file = transferItemFile(item);
    if (entry?.isDirectory) {
      directoryCandidates.push({
        name: String(entry.name || file?.name || 'folder').trim() || 'folder',
        file,
      });
    } else if (file) {
      files.push(file);
    }
  }
  const directoryNames = new Set(directoryCandidates.map((directory) => directory.name));
  const fileSignatures = new Set(files.map((file) => [file.name, file.type, file.size, file.lastModified].join(':')));
  for (const file of directFiles) {
    const signature = [file.name, file.type, file.size, file.lastModified].join(':');
    if (directoryNames.has(file.name) || fileSignatures.has(signature)) continue;
    fileSignatures.add(signature);
    files.push(file);
  }
  const directories = directoryCandidates.map((directory, index) => {
    const directHint = String(directory.file?.path || '').trim();
    const matchingHint = pathHints.find((hint) => pathHintBasename(hint) === directory.name)
      || (pathHints.length === directoryCandidates.length ? pathHints[index] : '');
    return {
      name: directory.name,
      pathHint: directHint || matchingHint,
      file: directory.file,
    };
  });
  return { directories, files };
}

export function appendComposerReferences(draft, references, { textLimit = 12000 } = {}) {
  const current = String(draft || '');
  const texts = (Array.isArray(references) ? references : [])
    .map((reference) => String(typeof reference === 'string' ? reference : reference?.text || '').trim())
    .filter(Boolean);
  if (!texts.length) return current;
  const separator = current && !current.endsWith('\n') ? '\n' : '';
  return `${current}${separator}${texts.join('\n')}`.slice(0, textLimit);
}

export function shouldConvertPastedTextToAttachment(draft, text, {
  attachmentThreshold = 1000,
  textLimit = 12000,
} = {}) {
  const draftLength = String(draft || '').length;
  const pastedLength = String(text || '').length;
  return pastedLength > 0 && (
    pastedLength >= attachmentThreshold
    || draftLength + pastedLength > textLimit
  );
}

export function richClipboardText(html = '', plainText = '') {
  const source = String(html || '').trim();
  const fallback = String(plainText || '');
  if (!source) return fallback;
  try {
    const markdown = richTextTurndown.turndown(source).trim();
    if (!markdown) return fallback;
    if (fallback && clipboardTextForComparison(markdown, { unescapeMarkdown: true })
      === clipboardTextForComparison(fallback)) {
      return fallback;
    }
    return markdown;
  } catch {
    return fallback;
  }
}

function clipboardTextForComparison(value, { unescapeMarkdown = false } = {}) {
  const text = unescapeMarkdown
    ? String(value || '').replace(/\\([\\`*_\[\]{}()#+.!>|~-])/g, '$1')
    : String(value || '');
  return text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

export function sessionTranscriptAwayFromLatest({
  scrollHeight = 0,
  scrollTop = 0,
  clientHeight = 0,
} = {}, threshold = 200) {
  return Number(scrollHeight) - Number(scrollTop) - Number(clientHeight) > threshold;
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
