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

Hosts may opt into `independentStartup: true`. The selected Session reads and
subscribes while the first catalogue page is pending. Catalogue failures are
published separately as `listError`, with `listLoading` / `listLoadingMore` for
navigation; a retry does not clear the selected conversation. Creation remains
immediate and refreshes a pending initial catalogue in the background so paging
can recover. The default startup ordering remains unchanged.

## UI extensions and state

With `compactComposer: true`, `composerPresentation: "split-send"` places the
running Turn's send-mode menu beside the send button. The menu also works with an
empty draft, and its selected mode controls both the button and Enter. It opens
upward, supports keyboard dismissal/navigation, and uses 44px controls. A model
entry switches to a brain icon only when its actual container cannot fit the
label. Other consumers retain their existing presentation. Hosts can supply
`actions.onLoadExecutionOptions()` to read metadata when options are opened or
focused; concurrent reads are deduplicated per Session, with a local retry on
failure. This callback never changes Runtime ownership or authorization.

The default `src/ui/markdown.jsx` entry renders synchronously, including SSR.
Browser Hosts can resolve that internal module to `src/ui/markdown-lazy.jsx` in
their bundler to split ordinary Markdown and math into separate imports. The
optional entry preserves readable text while loading or after a resource error;
formula code is requested only when non-user content contains math delimiters.

Use list/header/composer/auxiliary-panel slots for product functionality. `SessionComposerUtilities` accepts Host-owned `voice.start()` and context read/compact callbacks; recording returns text into the draft and never submits automatically. Side Chat, Subagent, and Realtime use the public panels with Host actions.

Context usage stays live through `context.usage`, including an explicit `null` when the Host has no current capacity. A dialog read's `tokenUsage` is retained only until a newer Host usage snapshot arrives. Hosts can set `context.isDraft` to label an unsent draft as “未开始”; Platform does not infer a model capacity.

`SideChatPanel.singleChat` omits its internal chat selector for Hosts that support one Side Chat and already provide an outer tab. `SessionRealtimePanel` supplies default labels and accepts `inline` to show controls inside a Host-owned dialog. Opening the panel reads voice choices; microphone capture begins only when the user starts. Unmounting disposes media and requests a stop for an active realtime conversation.

The compact Composer measures natural control width. Full model/effort/access/Fast controls stay inline when they fit; narrower layouts use one options panel. Desktop drawer preference is stored separately from Session draft/reading state. Up to 50 Session UI states are recoverable through optional browser session storage; incomplete uploads are not restored as ready attachments.

The Composer keeps its textarea editable without a formatted-preview step. Plain text, a standalone heading and a single list item preserve the clipboard's literal text. Structurally complex rich content, including multi-block content, multi-item lists, tables, fenced code, blockquotes and multi-paragraph content, becomes a Markdown attachment; long unstructured text follows the existing plain-text attachment threshold. File and directory drops route through the shared workspace actions, with authorization and upload owned by the Host.

The full-page application hides the redundant list total by default (`browser.showSessionCount` can opt in). Its sidebar toggle stays at the same top-left position through hover, focus, opening and closing; no layout transition or spare column remains when the desktop list is open. The collapsed detail header reserves space for the toggle. Embedded consumers retain their existing chrome.

Hosts enable sidebar-to-Composer references by providing `sessions[].reference` (`hostId` and native `threadId`, with cached labels), plus `onSearchSessionReferences`, `onResolveSessionReferences` and `onOpenSessionReference`. The Composer shares drag, `@` selection, removable chips, duplicate checks and per-Session recovery. `threadId` identifies self references even when the selected UI `sessionId` is an alias. References are included in submit and edit callbacks.

Minimal Host authorizes references against its owned Session store; shared, foreign-owner, self and archived targets fail closed without creating a Runtime. Its submission envelope includes bounded recent public context and stores only pointers on the visible user message. Queue and edit retain those pointers. Full consumers own their equivalent authorization and context read; the pure `createSessionReferenceEnvelopeInput` serializer accepts an optional Host-authorized `contextByKey` map (at most 3,000 characters per reference). Parsing removes that model-only data from visible text and metadata.

Current public intermediate messages and tool output remain readable in order. Active process groups are open by default; completed records collapse by default and scroll only when content exceeds the limit. Final assistant replies use the conversation scroll area. Scroll cues occupy a separate small gutter and disappear at the bottom.

`SessionWorkspace.technicalDetailsPresentation="progressive"` opts into a collapsed execution group. Inside it, commentary and simple text/media/file records render directly; commands and tool records with call details or output retain an individual disclosure. Hosts may designate an observation with `technicalItems[].disclosure="inline"` when it should show directly despite technical metadata. Both completed and active groups start collapsed; closing and reopening preserves the current item choices. Opening a complex item shows its body, call detail, output and available media/files together. Only long outputs have their own bounded scroll region. Record media uses the Host's `onOpenArtifact` action when supplied, so it can share the existing station preview instead of opening a new page.

Hosts list fully read turn IDs in `session.technicalDetailsLoaded`. A historical turn in `technicalDetailsAvailable` is read through `onLoadTechnicalDetails(turnId)` when its group opens, including restored expansion after refresh. That Promise must settle only after the full projection is available; it may return `{ technicalItems }` to display the result directly. Loading hides partial preview rows, read failures offer an inline retry, and an actual item count appears only inside a completed, fully read group. Live and unknown totals remain unlabeled. Transport caching and concurrent read deduplication belong to the Host.

## Modules and validation

`SessionWorkspace.technicalDetailsPresentation="tabbed"` uses one collapsed Turn detail card with an execution tab and optional Host-owned tabs. `extensions.getTurnDetailTabs({ message, session, turnKey })` is evaluated for the last visible message in each Turn and returns `{ id, label, count?, renderContent() }` entries; IDs must be unique and must not use the reserved `execution` ID. Product memory sources and authorized file opening remain Host-owned. Clicking a tab opens its shared content area; one control collapses the entire card. Arrow keys, Home and End select tabs. Switching tabs or collapsing retains execution read/cache and item expansion choices. Only opening the execution tab triggers a historical read; the completed content remains bounded, while active content is unbounded. Counts appear only when known. Simple text progress and its status share a row without a repeated provider heading. Existing default/progressive consumers retain their assembly contracts.

- `src/session-host.js`: selection, recovery and operations.
- `src/ui/session-application.jsx`: common application and finder.
- `src/ui/index.jsx`, `model.js`, `styles.css`: public components and presentation.
- `src/ui/session-ui-state.js`, `composer-utilities.jsx`: browser recovery and input utilities.
- `src/environment/host-adapter.js`: Minimal Host's transport projection.

`test/session-host.test.js`, `session-ui-state.test.js`, and the existing Kernel/UI suites cover state and protocol contracts. Project-owned `scripts/testing/session-ui.flow.mjs` is recorded with workspace Playwright against the built application, using isolated synthetic Runtime state. It does not establish physical microphone, iOS keyboard, or production account acceptance.

Consumer adoption remains independent: package tests establish Platform correctness, while each consumer verifies its mounted surfaces and pins an accepted release through its own delivery process. See [`operations/RELEASING.md`](operations/RELEASING.md). Resource lifecycle coordination and configurable built-in Minimal Host extensions remain separate from the implemented common application; their open design is in [`specs/consumer-host-convergence.md`](specs/consumer-host-convergence.md).
