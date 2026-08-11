export const APP_SERVER_FEATURES = Object.freeze(['realtime_conversation']);

import { sessionAttachmentKind } from './attachments.js';

export {
  CodexSubagentService,
  activeCodexTurn,
  codexThreadStatus,
  normalizeCodexSubagent,
  normalizeCodexThreadTree,
  rememberCodexSubagentMetadata,
} from './subagents.js';

export const APP_SERVER_REQUEST_METHODS = Object.freeze({
  command_approval: 'item/commandExecution/requestApproval',
  file_approval: 'item/fileChange/requestApproval',
  permission_approval: 'item/permissions/requestApproval',
  user_input: 'item/tool/requestUserInput',
  elicitation: 'mcpServer/elicitation/request',
});

export function appServerLaunchArgs({ listenUrl = '', features = APP_SERVER_FEATURES } = {}) {
  const args = ['app-server'];
  for (const feature of uniqueStrings(features)) args.push('--enable', feature);
  if (String(listenUrl || '').trim()) args.push('--listen', String(listenUrl).trim());
  return args;
}

export function appServerRequestMethod(requestType) {
  const type = String(requestType || '').trim();
  return APP_SERVER_REQUEST_METHODS[type] || `core/${type || 'unknown'}`;
}

export function appServerRuntimeCapabilities({
  enabled = true,
  browserMcp = false,
  features = APP_SERVER_FEATURES,
} = {}) {
  const active = Boolean(enabled);
  const featureSet = new Set(uniqueStrings(features));
  return {
    startupQueue: active,
    interruptTurn: active,
    appCommands: active,
    skills: active,
    threadSearch: active,
    threadFork: active,
    subagents: active,
    audioInput: active,
    threadTree: active,
    sideChat: active,
    attachments: active,
    approvals: active,
    browserMcp: active && Boolean(browserMcp),
    realtimeV3: active && featureSet.has('realtime_conversation'),
  };
}

export function appServerAttachmentInput({ mimeType = '', name = '', path = '' } = {}) {
  const normalizedPath = String(path || '').trim();
  if (!normalizedPath) throw new TypeError('Attachment path is required.');
  const normalizedName = String(name || '').trim();
  const kind = sessionAttachmentKind({ mimeType, name: normalizedName, path: normalizedPath });
  if (kind === 'audio') {
    return { type: 'localAudio', path: normalizedPath };
  }
  if (kind === 'image') return { type: 'localImage', path: normalizedPath };
  return { type: 'mention', name: normalizedName || 'attachment', path: normalizedPath };
}

export class CodexAppServerApi {
  constructor(connectionOrRequest) {
    if (typeof connectionOrRequest === 'function') {
      this.requester = connectionOrRequest;
      this.connection = null;
    } else if (typeof connectionOrRequest?.request === 'function') {
      this.connection = connectionOrRequest;
      this.requester = (method, params) => connectionOrRequest.request(method, params);
    } else {
      throw new TypeError('An App Server request function or connection is required.');
    }
  }

  async request(method, params = {}) {
    await this.connection?.start?.();
    return this.requester(method, params);
  }

  listThreads(params = {}) {
    return this.request('thread/list', params);
  }

  async readThread(threadId, { includeTurns = false } = {}) {
    requiredId(threadId, 'Thread');
    const result = await this.request('thread/read', { threadId, includeTurns });
    return result?.thread || null;
  }

  deleteThread(threadId) {
    requiredId(threadId, 'Thread');
    return this.request('thread/delete', { threadId });
  }

  setThreadName(threadId, name) {
    requiredId(threadId, 'Thread');
    return this.request('thread/name/set', { threadId, name });
  }

  listRealtimeVoices() {
    return this.request('thread/realtime/listVoices', {});
  }

  startRealtime(threadId, params = {}) {
    requiredId(threadId, 'Thread');
    return this.request('thread/realtime/start', { ...params, threadId });
  }

  appendRealtimeAudio(threadId, audio) {
    requiredId(threadId, 'Thread');
    return this.request('thread/realtime/appendAudio', { threadId, audio });
  }

  appendRealtimeText(threadId, text, role = 'user') {
    requiredId(threadId, 'Thread');
    return this.request('thread/realtime/appendText', { threadId, text, role });
  }

  stopRealtime(threadId) {
    requiredId(threadId, 'Thread');
    return this.request('thread/realtime/stop', { threadId });
  }
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || '').trim()).filter(Boolean))];
}

function requiredId(value, label) {
  if (!String(value || '').trim()) throw new TypeError(`${label} id is required.`);
}
