import { EntryRoute, incomingMessage } from './incoming-alerts';
import { EntrySettings, publicNumbersFor, validateEntry } from './twilio-entry';
import { MondayItemInput } from './monday';

export interface BridgeLeg {
  parentSid: string;
  childSid: string;
  caller: string;
  landing: string;
  initiated: number;
}

export interface QueueArrival {
  call_id: string;
  call_history_uuid?: string;
  id?: string;
  call_result?: string;
  direction?: string;
  start_time?: string;
  end_time?: string;
  caller_did_number?: string;
  callee_did_number?: string;
  callee_ext_type?: string;
  callee_ext_number?: string;
}

export interface PostedAlert {
  state: string;
  route: string;
  channel: string;
  ts?: string;
  entry?: string;
  childSid?: string;
  caller?: string;
  callerName?: string;
  landing?: string;
  initiated?: number;
  receipt?: SlackReceipt;
}

export interface SlackReceipt { parentSid: string; channel: string; ts: string; text: string }
const phone = /^\+[1-9]\d{7,14}$/;
const sid = /^CA[0-9a-f]{32}$/i;

// Both providers round call start times to seconds. Test calls reached the dedicated
// destination between one second before and five seconds after Twilio's dial event.
function couldBeSameCall(leg: BridgeLeg, row: QueueArrival): boolean {
  const delta = Date.parse(row.start_time || '') - leg.initiated;
  return row.caller_did_number === leg.caller && row.callee_did_number === leg.landing &&
    delta >= -1000 && delta <= 5000;
}

export function matchQueueArrival(leg: BridgeLeg, allLegs: BridgeLeg[], history: QueueArrival[],
  landing: string, queueExt: string, entryType = 'call_queue'): string | undefined {
  if (!sid.test(leg.parentSid) || !sid.test(leg.childSid) || !phone.test(leg.caller) ||
      leg.landing !== landing || !phone.test(landing)) return;
  const arrivals = history.filter(row => row.direction === 'inbound' && row.callee_ext_type === entryType &&
    row.callee_ext_number === queueExt && couldBeSameCall(leg, row));
  const ids = new Set(arrivals.map(row => row.call_id));
  if (ids.size !== 1 || !/^\d+$/.test(arrivals[0]?.call_id || '')) return;
  // Include competing Twilio legs even when their early Slack post failed.
  const others = allLegs.filter(other => arrivals.some(row => couldBeSameCall(other, row)));
  if (!others.some(other => other.parentSid === leg.parentSid && other.childSid === leg.childSid) ||
      others.some(other => other.parentSid !== leg.parentSid || other.childSid !== leg.childSid) ||
      allLegs.some(other => other.parentSid === leg.parentSid && other.childSid !== leg.childSid)) return;
  return arrivals[0].call_id;
}

export interface OriginalMessage {
  ts: string;
  text: string;
  metadata?: { event_type?: string; event_payload?: { parent_call_sid?: string } };
}

export interface QueueIdentity { name: string; kind: string; extension?: string }
interface LinkServices {
  menuQueue?(call: QueueArrival): Promise<QueueIdentity | undefined>;
  itemForZoomCall(id: string): Promise<string | undefined>;
  workflowOwner(id: string): Promise<{ slack_parent_ts?: string | null; monday_item_id?: string | null } | null>;
  originalMessage(channel: string, ts: string): Promise<OriginalMessage | undefined>;
  permalinkMatches(channel: string, ts: string): Promise<boolean>;
  editRecorded(parentSid: string, zoomId: string, item: string, channel: string, ts: string): Promise<boolean>;
  recordEdit(parentSid: string, zoomId: string, item: string, channel: string, ts: string): Promise<void>;
  forwardedTo(call: QueueArrival, bridge: string): Promise<boolean>;
  reserve(parentSid: string, zoomId: string, channel: string, ts: string, observedItem: string | undefined,
    caller: string, started: number, ended: number, status: 'ANSWERED' | 'ENDED', queue: QueueIdentity): Promise<void>;
  createOnce(parentSid: string, input: MondayItemInput): Promise<string | undefined>;
  ensureNumberCalled?(item: string, zoomId: string, number: string): Promise<void>;
  bindItem(parentSid: string, zoomId: string, item: string): Promise<void>;
  edit(channel: string, ts: string, text: string): Promise<{ ok: boolean; ts?: string }>;
}

export async function linkFirstNumber(leg: BridgeLeg, allLegs: BridgeLeg[], history: QueueArrival[],
  alert: PostedAlert, settings: EntrySettings, channel: string, queueExt: string,
  services: LinkServices, apply: boolean) {
  validateEntry(settings);
  const route = alert.route as EntryRoute;
  const publicNumbers = publicNumbersFor(settings, route);
  if (!publicNumbers.length || !queueExt || !alert.entry || settings.ingress[alert.entry] !== route ||
      alert.state !== 'posted' || alert.channel !== channel || !/^\d+\.\d+$/.test(alert.ts || '') ||
      alert.childSid !== leg.childSid ||
      alert.caller !== leg.caller || alert.landing !== leg.landing ||
      !Number.isFinite(alert.initiated) || Math.abs(alert.initiated! - leg.initiated) > 2000) return 'unverified-alert';
  const entryType = route === 'receptionist' ? 'auto_receptionist' : 'call_queue';
  const zoomId = matchQueueArrival(leg, allLegs, history, settings.destinations[route]!, queueExt, entryType);
  if (!zoomId) return 'unresolved-call';
  const arrival = history.find(row => row.call_id === zoomId && row.direction === 'inbound' &&
    row.callee_ext_type === entryType && row.callee_ext_number === queueExt && couldBeSameCall(leg, row))!;
  const ended = Date.parse(arrival.end_time || '');
  if (!Number.isFinite(ended) || ended < Date.parse(arrival.start_time!)) return 'awaiting-history';
  // The Zoom-hosted public number is a separate PSTN leg. Someone dialing the
  // private Twilio number directly must never be recorded as an 855 caller.
  const possibleOrigin = (other: BridgeLeg, row: QueueArrival) => {
    const elapsed = other.initiated - Date.parse(row.start_time || '');
    return row.direction === 'inbound' && publicNumbers.includes(row.callee_did_number || '') &&
      row.caller_did_number === other.caller && elapsed >= -1000 && elapsed <= 15000;
  };
  const origins = history.filter(row => possibleOrigin(leg, row));
  const origin = origins[0];
  if (!origin?.call_id || !origin.callee_did_number || origin.call_id === zoomId ||
      new Set(origins.map(row => row.call_id + '/' + row.callee_did_number)).size !== 1 ||
      allLegs.some(other => other.childSid !== leg.childSid && origins.some(row => possibleOrigin(other, row))) ||
      !await services.forwardedTo(origin, alert.entry)) return 'unverified-origin';
  const ts = alert.ts!;
  const call = { route, callerNumber: leg.caller, callerName: alert.callerName };
  const expected = incomingMessage(call);
  let originalText: string;
  if (alert.receipt) {
    const r = alert.receipt;
    if (r.channel !== channel || r.ts !== ts || r.parentSid !== leg.parentSid || r.text !== expected ||
        !await services.permalinkMatches(channel, ts)) return 'unverified-message';
    originalText = r.text;
  } else {
    const original = await services.originalMessage(channel, ts);
    if (original?.ts !== ts || original.metadata?.event_type !== 'roofbuddy_incoming_call' ||
        original.metadata.event_payload?.parent_call_sid !== leg.parentSid) return 'unverified-message';
    originalText = original.text;
  }
  if (route === 'receptionist' && !services.menuQueue) throw Error('Missing menu history reader');
  const firstQueue = route === 'queue111' ? { name: '111', kind: 'MAIN', extension: queueExt } : await services.menuQueue!(arrival);
  const finalCall = { ...call, firstQueue };
  const ownership = firstQueue ?? { name: 'Main Auto Receptionist', kind: 'OTHER', extension: queueExt };
  let item = await services.itemForZoomCall(zoomId);
  if (item && !/^\d+$/.test(item)) throw Error('Invalid Monday item ID');
  const owner = await services.workflowOwner(zoomId);
  if ((owner?.slack_parent_ts && owner.slack_parent_ts !== ts) ||
      (owner?.monday_item_id && String(owner.monday_item_id) !== item)) return 'workflow-conflict';
  const alreadyLinked = !!item && (originalText === incomingMessage({ ...finalCall, mondayItemId: item }) ||
    (!!alert.receipt && await services.editRecorded(leg.parentSid, zoomId, item, channel, ts)));
  if (!alreadyLinked && originalText !== expected) return 'message-changed';
  if (!apply) return alreadyLinked ? 'already-linked' : item ? 'ready' : 'would-create-item';
  const status = arrival.call_result === 'answered' ? 'ANSWERED' : 'ENDED';
  await services.reserve(leg.parentSid, zoomId, channel, ts, item, leg.caller, leg.initiated, ended, status, ownership);
  if (item && !alreadyLinked) await services.ensureNumberCalled?.(item, zoomId, origin.callee_did_number);
  if (!item) {
    item = await services.createOnce(leg.parentSid, { zoomCallId: zoomId, callerPhone: leg.caller,
      callerName: alert.callerName, incomingDateIso: new Date(origin.start_time!).toISOString(),
      callStatus: status, callQueue: firstQueue?.kind === 'MAIN' ? 'MAIN' : firstQueue?.kind === 'OVERFLOW' ? 'OVERFLOW' :
        firstQueue?.kind === 'ANSWERING_SERVICE' ? 'ANSWERING_SERVICE' : undefined,
      source: ownership.name, numberCalled: origin.callee_did_number });
    if (!item) return 'awaiting-item';
    if (!/^\d+$/.test(item)) throw Error('Invalid created Monday item ID');
  }
  await services.bindItem(leg.parentSid, zoomId, item);
  if (alreadyLinked) return 'already-linked';
  const linked = incomingMessage({ ...finalCall, mondayItemId: item });
  const result = await services.edit(channel, ts, linked);
  if (!result.ok || result.ts !== ts) throw Error('Original Slack alert edit was not confirmed');
  await services.recordEdit(leg.parentSid, zoomId, item, channel, ts);
  return 'linked';
}
