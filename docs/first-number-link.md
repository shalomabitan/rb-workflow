# Link an early alert to the Incoming Calls board

The first-number route keeps the public line at Zoom. The protected Twilio voice handler dials a dedicated Zoom queue number. Its initiated callback posts the queue alert independently of the board. The receipt in Twilio Sync records the original Slack timestamp and both Twilio call identities for seven days.

The follow-up command previews one UTC day at a time. It reads adjacent dates to check for competing calls around midnight. Run it from a checkout with dependencies installed and credentials supplied by the deployment environment.

```sh
npm run link:first-number -- YYYY-MM-DD
```

The command requires the single-number configuration in `ENTRY_SETTINGS`, the destination extension in `FIRST_QUEUE_EXTENSION`, the Slack bot token and channel, the Monday token, and the existing Supabase URL and service key. It uses `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, and `TWILIO_SYNC_SERVICE_SID` to read voice calls and receipts. Zoom server-to-server OAuth uses `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, and `ZOOM_CLIENT_SECRET` with access to account call history and individual call paths.

A match requires the public Zoom line to show forwarding to the configured bridge. It also requires a unique incoming call on the private queue number, agreement with the actual Twilio dial attempt, and the original Slack post with matching metadata. Hidden caller IDs, competing calls, modified Slack messages and conflicts in the existing workflow remain unresolved. The report prints counts without caller details.

An explicit `--apply` reserves the provider identities and adopts the original Slack parent in the existing workflow. It reuses the item with the exact Zoom call ID. When that item is missing, a single claimant requests its creation. A retry looks up the saved item after a lost response. If the create claim remains pending with no visible item, inspect the Monday request before recovering it. The link is added by editing the original message.

## Rollout verification

The command has no enabled schedule. Run a private end-to-end call through the actual forwarder and verify the original Slack post, the board row, the timing relative to the team ring and the existing processor's ownership. An independent Zoom notification that precedes adoption is reported as a conflict. Production activation requires resolving that timing case and verifying that the production runner can read both Zoom call paths. Keep all comparable calls on unrelated public lines on their existing route.
