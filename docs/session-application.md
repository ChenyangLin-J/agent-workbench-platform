# Shared Session application and Host Kit

`SessionApplication` is the common full-page application used by Minimal Host and Agent Web. It composes the Session list, finder, transcript, execution records, Composer, and responsive drawer. Hosts supply data and authorized callbacks; they do not rebuild those controls. Embedded `SessionBrowser` and `SessionWorkspace` remain supported.

## Ownership

| Platform | Consumer |
| --- | --- |
| Session/message/Turn presentation, queue and request controls | Runtime selection, HTTP/WS/SSE protocol, authorization and storage |
| Recent/favorite/archive presentation, title/body finder and paging interaction | Authorized list/search/archive/favorite operations and query cursors |
| Chronological public process cards, active/final layout, bounded completed output | Public event projection and file/media authorization |
| Draft, attachment, Session reference, reading position and process-expansion UI state | Upload transport, resource identity and persistence policies |
| Operation identity, stale-selection protection, snapshot recovery and event merging | Durable acceptance receipts and operation dispatch |
| Input width measurement, voice button, context display and shared auxiliary panels | Recording/transcription service, usage reads, account and product menus |

Product memory, project/task organization, integrations, credentials, service management, notification subscription and deployment belong to the consumer. A generic controller or interaction moves to Platform only when it can accept a Host contract without importing a product endpoint, identity, or persistence policy.

## Public assembly

```jsx
import { createSessionHostController } from '@agent-workbench/platform/session-host';
import { SessionApplication } from '@agent-workbench/platform/ui';
import '@agent-workbench/platform/styles.css';

const controller = createSessionHostController({ adapter, initialSessionId, capabilities });
<SessionApplication controller={controller} detail={state => ({
  session: state.session, compactComposer: true, features, actions, extensions,
})} />;
```

The adapter provides `listSessions`, `readSession`, `createSession`, `execute`, and optionally `subscribeSession`, `applyEvent`, `loadHistory`, `markResultRead`, and merge/summary callbacks. `applyEvent` returns a canonical snapshot directly. A snapshot's nested `session` may contain product metadata; it is not an implicit envelope. The outer `sessionId` identifies the selected UI Session, while `threadId` may identify a native Codex thread.

Snapshots and events carry monotonically comparable `revision` values when the Host supports them. A snapshot watermark describes the projection actually returned. Reconnection buffers events while reading an authoritative snapshot, then applies only later revisions. Changing the native thread behind one UI Session replaces its old transcript rather than merging histories across branches.

`execute` retains an operation ID until acceptance is known. The Host must deduplicate that ID durably. A timeout is an unknown outcome; it is not permission to submit a second operation. Definitive client rejection can set `knownResult=true`, allowing a corrected retry. Accepted operations stay accepted when a subsequent snapshot read fails.

Accepted creation inserts the returned Session into the local list and selects it without waiting for another history list request. Older in-flight lists cannot remove that row. If the user has selected another Session while creation was pending, that newer selection wins. Hosts may explicitly refresh lists for their own paging or metadata needs.

## UI extensions and state

Use list/header/composer/auxiliary-panel slots for product functionality. `SessionComposerUtilities` accepts Host-owned `voice.start()` and context read/compact callbacks; recording returns text into the draft and never submits automatically. Side Chat, Subagent, and Realtime use the public panels with Host actions.

Context usage stays live through `context.usage`, including an explicit `null` when the Host has no current capacity. A dialog read's `tokenUsage` is retained only until a newer Host usage snapshot arrives. Hosts can set `context.isDraft` to label an unsent draft as “未开始”; Platform does not infer a model capacity.

`SideChatPanel.singleChat` omits its internal chat selector for Hosts that support one Side Chat and already provide an outer tab. `SessionRealtimePanel` supplies default labels and accepts `inline` to show controls inside a Host-owned dialog. Opening the panel reads voice choices; microphone capture begins only when the user starts. Unmounting disposes media and requests a stop for an active realtime conversation.

The compact Composer measures natural control width. Full model/effort/access/Fast controls stay inline when they fit; narrower layouts use one options panel. Desktop drawer preference is stored separately from Session draft/reading state. Up to 50 Session UI states are recoverable through optional browser session storage; incomplete uploads are not restored as ready attachments.

The full-page application hides the redundant list total by default (`browser.showSessionCount` can opt in). Its sidebar toggle stays at the same top-left position through hover, focus, opening and closing; no layout transition or spare column remains when the desktop list is open. The collapsed detail header reserves space for the toggle. Embedded consumers retain their existing chrome.

Hosts enable sidebar-to-Composer references by providing `sessions[].reference` (`hostId` and native `threadId`, with cached labels), plus `onSearchSessionReferences`, `onResolveSessionReferences` and `onOpenSessionReference`. The Composer shares drag, `@` selection, removable chips, duplicate checks and per-Session recovery. `threadId` identifies self references even when the selected UI `sessionId` is an alias. References are included in submit and edit callbacks.

Minimal Host authorizes references against its owned Session store; shared, foreign-owner, self and archived targets fail closed without creating a Runtime. Its submission envelope includes bounded recent public context and stores only pointers on the visible user message. Queue and edit retain those pointers. Full consumers own their equivalent authorization and context read; the pure `createSessionReferenceEnvelopeInput` serializer accepts an optional Host-authorized `contextByKey` map (at most 3,000 characters per reference). Parsing removes that model-only data from visible text and metadata.

Current public intermediate messages and tool output remain readable in order. Active process groups are open by default; completed records collapse by default and scroll only when content exceeds the limit. Final assistant replies use the conversation scroll area. Scroll cues occupy a separate small gutter and disappear at the bottom.

## Modules and validation

- `src/session-host.js`: selection, recovery and operations.
- `src/ui/session-application.jsx`: common application and finder.
- `src/ui/index.jsx`, `model.js`, `styles.css`: public components and presentation.
- `src/ui/session-ui-state.js`, `composer-utilities.jsx`: browser recovery and input utilities.
- `src/environment/host-adapter.js`: Minimal Host's transport projection.

`test/session-host.test.js`, `session-ui-state.test.js`, and the existing Kernel/UI suites cover state and protocol contracts. Project-owned `scripts/testing/session-ui.flow.mjs` is recorded with workspace Playwright against the built application, using isolated synthetic Runtime state. It does not establish physical microphone, iOS keyboard, or production account acceptance.
