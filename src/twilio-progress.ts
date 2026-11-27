import { incomingMessage, EntryRoute } from './incoming-alerts';
import { EntrySettings, publicNumbersFor, validateEntry } from './twilio-entry';
import { postSlackMessage } from './slack';
import type { SlackReceipt } from './first-number-link';

interface ParentCall {
  to: string;
  from: string;
  callerName?: string | null;
  direction: string;
}

interface ProgressEvent {
  AccountSid: string;
  CallSid: string;
  ParentCallSid: string;
  CallStatus: string;
  Timestamp: string;
  To: string;
  route: EntryRoute;
}

type Delivery = { state: 'posting' | 'posted'; route: EntryRoute; channel: string; ts?: string;
  entry?: string; childSid?: string; caller?: string; callerName?: string; landing?: string; initiated?: number;
  receipt?: SlackReceipt };
interface Documents {
  create(options: { uniqueName: string; data: Delivery; ttl: number }): Promise<unknown>;
  (name: string): {
    fetch(): Promise<{ data: Delivery }>;
    update(options: { data: Delivery }): Promise<unknown>;
    remove(): Promise<boolean>;
  };
}
interface Client {
  calls(sid: string): { fetch(): Promise<ParentCall> };
  sync: { v1: { services(sid: string): { documents: Documents } } };
}
interface Context {
  ACCOUNT_SID: string;
  ENTRY_SETTINGS: string;
  SYNC_SERVICE_SID: string;
  SLACK_BOT_TOKEN: string;
  SLACK_CHANNEL_ID: string;
  getTwilioClient(): Client;
}

const callSid = /^CA[0-9a-f]{32}$/i;
const keepSeconds = 7 * 24 * 60 * 60;
function hasStatus(error: unknown, status: number): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === status;
}

// Register this endpoint as Protected. The signed callback identifies the child leg.
// The original inbound call is the unit of notification, including on callback retries.
export async function deliverProgress(context: Context, event: ProgressEvent, post = postSlackMessage): Promise<void> {
  const settings: EntrySettings = JSON.parse(context.ENTRY_SETTINGS);
  validateEntry(settings);
  if (event.AccountSid !== context.ACCOUNT_SID || !callSid.test(event.ParentCallSid) ||
      !callSid.test(event.CallSid) || event.CallStatus !== 'initiated' ||
      !['queue111', 'receptionist'].includes(event.route) ||
      settings.destinations[event.route] !== event.To) throw new Error('Unexpected progress callback');
  // An old signed callback must not recreate a claim after the document expires.
  const age = Date.now() - Date.parse(event.Timestamp);
  if (!Number.isFinite(age) || age < -300_000 || age > 24 * 3600_000) throw new Error('Stale callback');

  const client = context.getTwilioClient();
  const parent = await client.calls(event.ParentCallSid).fetch();
  if (parent.direction !== 'inbound' || !Object.hasOwn(settings.ingress, parent.to) ||
      settings.ingress[parent.to] !== event.route) throw new Error('Parent call does not match the entry route');

  const documents = client.sync.v1.services(context.SYNC_SERVICE_SID).documents;
  const key = 'incoming-' + event.ParentCallSid;
  const document = documents(key);
  const claim: Delivery = { state: 'posting', route: event.route, channel: context.SLACK_CHANNEL_ID };
  const tracked = publicNumbersFor(settings, event.route).length > 0;
  if (tracked) {
    Object.assign(claim, { entry: parent.to, childSid: event.CallSid, caller: parent.from,
      callerName: parent.callerName || undefined, landing: event.To, initiated: Date.parse(event.Timestamp) });
  }
  try {
    await documents.create({ uniqueName: key, data: claim, ttl: keepSeconds });
  } catch (error) {
    if (!hasStatus(error, 409)) throw error;
    const existing = (await document.fetch()).data;
    if (existing.state === 'posted' && existing.ts) return;
    throw new Error('Delivery in progress or uncertain; reconcile Slack before resending ' + key);
  }

  // Network timeouts and unclear responses retain the claim to prevent a second parent.
  const text = incomingMessage({ route: event.route, callerNumber: parent.from, callerName: parent.callerName || undefined });
  const result = await post(context.SLACK_BOT_TOKEN, {
    channel: claim.channel, text, unfurl_links: false,
    metadata: { event_type: 'roofbuddy_incoming_call', event_payload: { parent_call_sid: event.ParentCallSid } },
  });
  if (!result.ok && result.error) {
    // Only definite pre-send rejection permits retry. Other Slack errors can be ambiguous.
    if (['ratelimited', 'not_in_channel', 'channel_not_found', 'invalid_auth', 'missing_scope'].includes(result.error)) {
      await document.remove();
    }
    throw new Error('Slack rejected incoming alert: ' + result.error);
  }
  if (!result.ok || !result.ts) throw new Error('Slack delivery uncertain: ' + key);
  if (tracked) {
    if (result.channel !== claim.channel) throw Error('Slack delivery channel not confirmed: ' + key);
    claim.receipt = { parentSid: event.ParentCallSid, channel: result.channel, ts: result.ts, text };
  }
  await document.update({ data: { ...claim, state: 'posted', ts: result.ts } });
}

export function handler(context: Context, event: ProgressEvent, callback: (error: Error | null) => void): void {
  deliverProgress(context, event).then(() => callback(null), error => callback(error));
}
