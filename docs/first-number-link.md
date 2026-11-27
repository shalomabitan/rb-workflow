# Link an early alert to the Incoming Calls board

The public lines stay at Zoom. Direct queue numbers can share a private bridge and queue landing. The main receptionist has a separate bridge and landing. `publicNumbers` lists the approved public numbers for each route. Older configurations with `firstPublicNumber` continue to select that one line. The protected Twilio voice handler dials a dedicated Zoom queue number. Its initiated callback posts the queue alert independently of the board. The receipt in Twilio Sync records the original Slack timestamp and both Twilio call identities for seven days.

The follow-up command previews one UTC day at a time. It reads adjacent dates to check for competing calls around midnight. Run it from a checkout with dependencies installed and credentials supplied by the deployment environment.

```sh
npm run link:first-number -- YYYY-MM-DD
```

The command requires the routing configuration in `ENTRY_SETTINGS`, the destination extension in `FIRST_QUEUE_EXTENSION`, the Slack bot token and channel, the Monday token, and the existing Supabase URL and service key. It uses `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY`, `TWILIO_API_SECRET`, and `TWILIO_SYNC_SERVICE_SID` to read voice calls and receipts. Zoom server-to-server OAuth uses `ZOOM_ACCOUNT_ID`, `ZOOM_CLIENT_ID`, and `ZOOM_CLIENT_SECRET` with access to account call history and individual call paths.

A match requires the public Zoom line to show forwarding to the configured bridge. It also requires a unique incoming call on the private queue number and agreement with the actual Twilio dial attempt. For new calls, the protected handler saves Slack's posting receipt. The follow-up checks the exact channel and timestamp with Slack's permalink API, then records the confirmed edit. Older receipts require matching Slack message metadata if available. Hidden caller IDs, competing calls and conflicts in the existing workflow remain unresolved. The report prints counts without caller details.

For the command-line runner, set `ZOOM_CREDENTIAL_PARAMETER` to the encrypted Parameter Store entry and select the intended AWS profile. The runner reads the credential into memory. The issued token must have exactly `phone:read:list_call_logs:admin` and `phone:read:call_log:admin`.

An explicit `--apply` reserves the provider identities and adopts the original Slack parent in the existing workflow. It reuses the item with the exact Zoom call ID. When that item is missing, a single claimant requests its creation. A retry looks up the saved item after a lost response. If the create claim remains pending with no visible item, inspect the Monday request before recovering it. The link is added by editing the original message. The board's Number Called comes from the verified public Zoom leg. A menu call starts with the main receptionist label. The same alert is edited with the first actual queue when Zoom reports one. Menu-only calls retain their original label.

## Rollout verification

The production stack runs the linker every two minutes. It retries completed calls after Zoom publishes their histories, checks the preceding UTC day around midnight, and reads saved edit receipts on subsequent runs. The production webhook verifies Twilio's signature before returning dialing instructions or processing a progress event. Configure the Twilio voice number with an independently hosted fallback that dials the dedicated Zoom landing number.

The existing processor continues storing events for the dedicated landing number. The bridge owns the initial Slack message and the linked board item for that number. Verify a public call against the first Zoom member ring, the original Slack timestamp, and the board item’s Zoom ID. To reverse the phone change, route the public number directly to its original Zoom queue.
