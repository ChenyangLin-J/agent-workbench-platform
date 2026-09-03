# Shared Session Access for Minimal Host

Status: implemented for v0.17.0

This extension lets a consumer authorize read-only access to selected portable Sessions without making Platform own accounts, shares, links, groups, or invitations.

## Trusted access envelope

The consumer configures both headers in `ai.ddit.agent-workbench.minimal-host`:

```json
{
  "sessionOwnerHeader": "x-consumer-user-id",
  "sessionAccessHeader": "x-consumer-session-access"
}
```

The Gateway removes browser-supplied values, authenticates the request, and injects a base64url-encoded JSON envelope:

```json
{
  "v": 1,
  "principalId": "user-123",
  "sharedSessions": [
    {
      "sessionId": "session-opaque",
      "shareId": "share-opaque",
      "permissions": ["session.read", "resource.read", "session.fork"]
    }
  ],
  "sharedOffset": 0,
  "sharedNextOffset": 72
}
```

`principalId` must exactly match the verified owner header. The Host accepts at most 100 grants and 16 KiB of encoded header data. A configured but absent, malformed, oversized, or mismatched envelope fails closed. When `sharedNextOffset` is present, the Minimal Host client requests `GET /api/sessions?sharedOffset=<offset>` and merges pages by Session id. The consumer authentication service must use that trusted request offset to construct the next bounded envelope. Detail/resource/continue requests should project the requested Session grant instead of a list page, so an older grant stays addressable. Platform never accepts a browser-authored grant.

The private Host token remains mandatory when configured. Session ids and Share ids are identifiers, never capabilities.

## Read-only projection

`GET /api/sessions` merges owned summaries with explicitly granted shared summaries. Shared records use `contextId: "shared"`, `contextLabel: "与我共享"`, `access.kind: "shared"`, and `composerDisabled: true`. Owned records use the consumer-neutral `owned` group when scoped access is enabled.

Shared detail removes Runtime bindings, Run ids, queue, pending requests, technical items, workspace references, owner identity, and mutation actions. Managed attachments require `resource.read` on every open. Shared Session event streams and every mutation fail with `SESSION_ACCESS_READ_ONLY`; clients poll the ordinary authorized GET route instead, so revocation is rechecked.

## Safe continuation

`POST /api/sessions/:sessionId/continue` requires `session.fork` and an `Idempotency-Key`. It never calls provider thread fork. The Host:

1. snapshots the authorized shared projection;
2. copies visible messages and managed attachments into a new Session owned by the current principal;
3. excludes technical state, external workspace references, queue, requests, Runtime binding and hidden context;
4. creates a fresh Runtime Session in the current Run;
5. seeds the first new Turn with only the copied visible transcript;
6. returns the same target Session for a retry with the same owner, Share and idempotency key.

The UI label is consumer copy; Datamama uses “继续聊”. The copied Session is independent, writable by its new owner, and is not deleted when the Share is later revoked.

## Consumer-owned responsibilities

The consumer owns identity, user search, Share/access persistence, capability links, revocation, audit, rate limits, retention, and construction/paging of the trusted envelope. It must verify ownership before creating a Share and reissue the envelope on every request. Platform never persists consumer users or capabilities in the transcript.
