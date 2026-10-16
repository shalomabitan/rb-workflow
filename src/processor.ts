import { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import {
  NormalizedEvent,
  CallRecord,
  CallQueueConfig,
  SpecialNumberConfig,
  CallStatus,
  RouteKind,
  EVENT_RANKS,
  mapEventToStatus,
  loadConfig,
  Config,
} from './types';
import { createMondayItem, updateMondayItemStatus, getMondayItemUrl, MondayItemInput, QUEUE_LABELS, STATUS_LABELS } from './monday';
import { getSupabaseClient, SupabaseClientType } from './supabase';
import { postSlackMessage, formatNewCallMessage, formatStatusUpdateMessage } from './slack';
import { turnBulbOff } from './lifx';

// ===================
// Dependencies for Testing
// ===================
export interface ProcessorDependencies {
  config: Config;
  supabase: SupabaseClientType;
  mondayCreate: (input: MondayItemInput) => Promise<string>;
  mondayUpdateStatus: (itemId: string, status: keyof typeof STATUS_LABELS, queue?: keyof typeof QUEUE_LABELS) => Promise<void>;
  slackPost: (channel: string, text: string, threadTs?: string) => Promise<{ ok: boolean; ts?: string }>;
  lifxOff: () => Promise<void>;
  now: () => number;
}

// ===================
// Supabase Operations
// ===================
async function getCallRecord(
  supabase: SupabaseClientType,
  callId: string
): Promise<CallRecord | undefined> {
  const { data, error } = await supabase
    .from('rb_calls')
    .select('*')
    .eq('call_id', callId)
    .single();

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows returned
    throw error;
  }

  if (!data) return undefined;

  // Map from Supabase row to CallRecord
  return {
    call_id: data.call_id,
    created_at_ms: data.created_at_ms || 0,
    last_event_ts_ms: data.last_event_ts_ms || 0,
    last_processed_event_ts_ms: data.last_event_ts_ms || 0,
    last_processed_rank: data.last_event_rank || 0,
    status: data.status as CallStatus,
    caller_phone_e164: data.caller_phone_e164 || undefined,
    caller_name: data.caller_name || undefined,
    main_queue_ext: data.forwarded_by_extension_number || undefined,
    main_queue_name: data.forwarded_by_name || undefined,
    overflowed: false, // TODO: Track in DB
    route_kind_current: (data.route_kind as RouteKind) || 'UNKNOWN',
    answered_by_name: undefined, // TODO: Add to schema
    monday_item_id: data.monday_item_id || undefined,
    slack_parent_ts: data.slack_parent_ts || undefined,
  };
}

async function getQueueConfig(
  supabase: SupabaseClientType,
  queueExt: string
): Promise<CallQueueConfig | undefined> {
  const { data, error } = await supabase
    .from('rb_call_queues')
    .select('*')
    .eq('queue_ext', queueExt)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data as CallQueueConfig | undefined;
}

async function getSpecialNumber(
  supabase: SupabaseClientType,
  phoneE164: string
): Promise<SpecialNumberConfig | undefined> {
  const { data, error } = await supabase
    .from('rb_special_numbers')
    .select('*')
    .eq('phone_e164', phoneE164)
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data as SpecialNumberConfig | undefined;
}

// ===================
// Classification Logic
// ===================
interface ClassificationResult {
  routeKind: RouteKind;
  queueConfig?: CallQueueConfig;
  specialNumber?: SpecialNumberConfig;
}

async function classifyEvent(
  supabase: SupabaseClientType,
  event: NormalizedEvent
): Promise<ClassificationResult> {
  // 1. Check for answering service (callee is PSTN and in SpecialNumbers)
  if (event.callee_extension_type === 'pstn' && event.callee_phone_e164) {
    const specialNumber = await getSpecialNumber(supabase, event.callee_phone_e164);
    if (specialNumber?.enabled && specialNumber.kind === 'ANSWERING_SERVICE') {
      return { routeKind: 'ANSWERING_SERVICE', specialNumber };
    }
  }

  // 2. Check for queue route (forwarded_by is callQueue)
  if (event.forwarded_by_extension_type === 'callQueue' && event.forwarded_by_extension_number) {
    const queueConfig = await getQueueConfig(supabase, event.forwarded_by_extension_number);
    if (queueConfig?.enabled) {
      return {
        routeKind: queueConfig.route_kind as RouteKind,
        queueConfig,
      };
    }
    return { routeKind: 'UNKNOWN' };
  }

  // 3. Check for user direct
  if (event.callee_extension_type === 'user') {
    return { routeKind: 'USER_DIRECT' };
  }

  return { routeKind: 'UNKNOWN' };
}

// ===================
// State Machine Guards
// ===================
function shouldApplyEvent(
  event: NormalizedEvent,
  existingCall?: CallRecord
): boolean {
  if (!existingCall) {
    return true; // New call, always apply
  }

  const eventRank = EVENT_RANKS[event.event_type] || 0;
  const lastTs = existingCall.last_processed_event_ts_ms || 0;
  const lastRank = existingCall.last_processed_rank || 0;

  // Apply if: newer timestamp OR (same timestamp AND higher rank)
  return (
    event.event_ts_ms > lastTs ||
    (event.event_ts_ms === lastTs && eventRank > lastRank)
  );
}

// ===================
// Build Call Record Update
// ===================
interface CallUpdate {
  status: string;
  caller_phone_e164?: string;
  caller_name?: string;
  callee_extension_type?: string;
  callee_extension_number?: string;
  callee_name?: string;
  forwarded_by_extension_type?: string;
  forwarded_by_extension_number?: string;
  forwarded_by_name?: string;
  route_kind?: string;
  monday_item_id?: string;
  slack_parent_ts?: string;
  last_event_id?: string;
  last_event_ts_ms?: number;
  last_event_rank?: number;
  created_at_ms?: number;
  updated_at_ms?: number;
}

function buildCallUpdate(
  event: NormalizedEvent,
  classification: ClassificationResult,
  existingCall: CallRecord | undefined,
  now: number
): CallUpdate {
  const newStatus = mapEventToStatus(event.event_type, existingCall?.status);
  const eventRank = EVENT_RANKS[event.event_type] || 0;

  const update: CallUpdate = {
    status: newStatus,
    last_event_ts_ms: event.event_ts_ms,
    last_event_rank: eventRank,
    updated_at_ms: now,
  };

  // Initialize new call
  if (!existingCall) {
    update.created_at_ms = now;
    update.caller_phone_e164 = event.caller_phone_e164;
    update.caller_name = event.caller_name;
    update.callee_extension_type = event.callee_extension_type;
    update.callee_extension_number = event.callee_extension_number;
    update.callee_name = event.callee_name;
    update.forwarded_by_extension_type = event.forwarded_by_extension_type;
    update.forwarded_by_extension_number = event.forwarded_by_extension_number;
    update.forwarded_by_name = event.forwarded_by_name;
    update.route_kind = classification.routeKind;
  }

  return update;
}

// ===================
// Save Call Record
// ===================
async function saveCallRecord(
  supabase: SupabaseClientType,
  callId: string,
  update: CallUpdate,
  existingCall?: CallRecord
): Promise<CallRecord> {
  if (!existingCall) {
    // Insert new record
    const { error } = await supabase
      .from('rb_calls')
      .insert({ call_id: callId, ...update });

    if (error) throw error;

    return {
      call_id: callId,
      created_at_ms: update.created_at_ms || 0,
      last_event_ts_ms: update.last_event_ts_ms || 0,
      last_processed_event_ts_ms: update.last_event_ts_ms || 0,
      last_processed_rank: update.last_event_rank || 0,
      status: update.status as CallStatus,
      caller_phone_e164: update.caller_phone_e164,
      caller_name: update.caller_name,
      overflowed: false,
      route_kind_current: (update.route_kind as RouteKind) || 'UNKNOWN',
      monday_item_id: update.monday_item_id,
      slack_parent_ts: update.slack_parent_ts,
    };
  }

  // Update existing record
  const { error } = await supabase
    .from('rb_calls')
    .update(update)
    .eq('call_id', callId);

  if (error) throw error;

  return {
    ...existingCall,
    status: update.status as CallStatus,
    last_event_ts_ms: update.last_event_ts_ms || existingCall.last_event_ts_ms,
    last_processed_event_ts_ms: update.last_event_ts_ms || existingCall.last_processed_event_ts_ms,
    last_processed_rank: update.last_event_rank || existingCall.last_processed_rank,
    monday_item_id: update.monday_item_id || existingCall.monday_item_id,
    slack_parent_ts: update.slack_parent_ts || existingCall.slack_parent_ts,
  };
}

// ===================
// Map RouteKind to Monday Queue Label
// ===================
function routeKindToQueueLabel(routeKind: RouteKind): keyof typeof QUEUE_LABELS | undefined {
  switch (routeKind) {
    case 'MAIN':
      return 'MAIN';
    case 'OVERFLOW':
      return 'OVERFLOW';
    case 'ANSWERING_SERVICE':
      return 'ANSWERING_SERVICE';
    default:
      return undefined;
  }
}

// ===================
// Map CallStatus to Monday Status Label
// ===================
function callStatusToMondayLabel(status: CallStatus): keyof typeof STATUS_LABELS | undefined {
  switch (status) {
    case 'RINGING':
      return 'RINGING';
    case 'ANSWERED':
      return 'ANSWERED';
    case 'MISSED':
      return 'MISSED';
    case 'ENDED':
      return 'ENDED';
    default:
      return undefined;
  }
}

// ===================
// Process Single Event
// ===================
async function processEvent(
  deps: ProcessorDependencies,
  event: NormalizedEvent
): Promise<void> {
  const { config, supabase, mondayCreate, mondayUpdateStatus, slackPost, now } = deps;
  const callId = event.call_id;
  const eventType = event.event_type;

  const existingCall = await getCallRecord(supabase, callId);

  if (!shouldApplyEvent(event, existingCall)) {
    console.log(`Skipping ${eventType} for ${callId}: out-of-order or duplicate`);
    return;
  }

  const classification = await classifyEvent(supabase, event);
  const previousStatus = existingCall?.status;
  const newStatus = mapEventToStatus(eventType, previousStatus);
  const update = buildCallUpdate(event, classification, existingCall, now());

  console.log(`${eventType} for ${callId}: ${previousStatus || 'NEW'} → ${newStatus} (route=${classification.routeKind})`);

  // Kick off LIFX turn-off the moment we know the call is leaving RINGING.
  // Fire in parallel with the Monday/Slack/save fan-out; drained at the end
  // of processEvent so Lambda doesn't freeze the in-flight fetch.
  // Note: if two MAIN-queue calls overlap, one ending will turn the bulb off
  // while the other is still ringing. Accepted tradeoff — the next ringing
  // event will re-light idempotently. Also ignores route_kind here so an
  // overflow'd call (route became OVERFLOW by the end) still turns off.
  const leavingRinging = previousStatus === 'RINGING' && newStatus !== 'RINGING';
  const lifxOffPromise: Promise<void> = leavingRinging
    ? deps.lifxOff().catch((err) => {
        console.error('LIFX off failed (non-blocking):', err);
      })
    : Promise.resolve();

  const isNewCall = !existingCall;
  const queueLabel = routeKindToQueueLabel(classification.routeKind);

  if (isNewCall && queueLabel) {
    try {
      const mondayItemId = await mondayCreate({
        callerPhone: event.caller_phone_e164 || 'Unknown',
        callerName: event.caller_name,
        incomingDateIso: new Date(event.event_ts_ms).toISOString(),
        callStatus: 'RINGING',
        callQueue: queueLabel,
        source: classification.queueConfig?.name,
        zoomCallId: callId,
      });
      update.monday_item_id = mondayItemId;
    } catch (error) {
      console.error('Monday item creation failed (non-blocking):', error);
    }
  } else if (existingCall?.monday_item_id) {
    const mondayStatus = callStatusToMondayLabel(newStatus as CallStatus);
    const statusChanged = previousStatus !== newStatus;
    const routeChanged = existingCall.route_kind_current !== classification.routeKind;
    const newQueueLabel = routeChanged ? queueLabel : undefined;

    if (statusChanged && mondayStatus) {
      try {
        await mondayUpdateStatus(existingCall.monday_item_id, mondayStatus, newQueueLabel);
      } catch (error) {
        console.error('Monday item update failed (non-blocking):', error);
      }
    }
  }

  const shouldPostSlack = queueLabel !== undefined;

  if (shouldPostSlack && isNewCall) {
    try {
      const mondayUrl = update.monday_item_id ? getMondayItemUrl(update.monday_item_id) : undefined;
      const slackMessage = formatNewCallMessage(
        event.caller_phone_e164 || 'Unknown',
        event.caller_name,
        classification.queueConfig?.name || classification.routeKind,
        classification.routeKind,
        mondayUrl
      );
      const result = await slackPost(config.slackChannelId, slackMessage);
      if (result.ts) {
        update.slack_parent_ts = result.ts;
      }
    } catch (error) {
      console.error('Slack post failed (non-blocking):', error);
    }
  } else if (existingCall?.slack_parent_ts && previousStatus !== newStatus) {
    try {
      const slackMessage = formatStatusUpdateMessage(previousStatus, newStatus, {
        answeredBy: event.callee_name,
        duration: event.duration_sec,
        routeKind: classification.routeKind,
        queueName: classification.queueConfig?.name,
      });
      await slackPost(config.slackChannelId, slackMessage, existingCall.slack_parent_ts);
    } catch (error) {
      console.error('Slack reply failed (non-blocking):', error);
    }
  }

  await saveCallRecord(supabase, callId, update, existingCall);

  await lifxOffPromise;
}

// ===================
// Create Handler with Dependencies
// ===================
export function createProcessorHandler(deps: ProcessorDependencies) {
  return async function handler(sqsEvent: SQSEvent): Promise<SQSBatchResponse> {
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of sqsEvent.Records) {
      try {
        const event = JSON.parse(record.body) as NormalizedEvent;
        await processEvent(deps, event);
      } catch (error) {
        console.error('Failed to process record:', record.messageId, error);
        batchItemFailures.push({ itemIdentifier: record.messageId });
      }
    }

    return { batchItemFailures };
  };
}

// ===================
// Default Handler (Lambda Entry Point)
// ===================
const config = loadConfig();
const supabase = getSupabaseClient();

export const handler = createProcessorHandler({
  config,
  supabase,
  mondayCreate: (input) => createMondayItem(config.mondayApiToken, input),
  mondayUpdateStatus: (itemId, status, queue) => updateMondayItemStatus(config.mondayApiToken, itemId, status, queue),
  slackPost: (channel, text, threadTs) =>
    postSlackMessage(config.slackBotToken, { channel, text, thread_ts: threadTs, unfurl_links: false }),
  lifxOff: () =>
    config.lifxToken ? turnBulbOff(config.lifxToken, config.lifxBulbLabel) : Promise.resolve(),
  now: () => Date.now(),
});
