import { SQSEvent, SQSBatchResponse, SQSBatchItemFailure } from 'aws-lambda';
import {
  NormalizedEvent,
  CallRecord,
  CallQueueConfig,
  SpecialNumberConfig,
  ZapierStateChangePayload,
  CallStatus,
  RouteKind,
  EVENT_RANKS,
  mapEventToStatus,
  loadConfig,
  Config,
} from './types';
import { createMondayItem, updateMondayItemStatus, getMondayItemActionCallUrl, MondayItemInput, QUEUE_LABELS, STATUS_LABELS } from './monday';
import { getSupabaseClient, SupabaseClientType } from './supabase';
import { postSlackMessage, formatNewCallMessage, formatStatusUpdateMessage } from './slack';

// ===================
// Dependencies for Testing
// ===================
export interface ProcessorDependencies {
  config: Config;
  supabase: SupabaseClientType;
  zapierFetch: (payload: ZapierStateChangePayload) => Promise<{ ok: boolean }>;
  mondayCreate: (input: MondayItemInput) => Promise<string>;
  mondayUpdateStatus: (itemId: string, status: keyof typeof STATUS_LABELS, queue?: keyof typeof QUEUE_LABELS) => Promise<void>;
  mondayGetActionCallUrl: (itemId: string) => Promise<string | undefined>;
  slackPost: (channel: string, text: string, threadTs?: string) => Promise<{ ok: boolean; ts?: string }>;
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
// Build Zapier Payload
// ===================
function buildZapierPayload(
  callRecord: CallRecord,
  previousStatus?: CallStatus
): ZapierStateChangePayload {
  return {
    event_type: 'state_change',
    triggered_at: new Date().toISOString(),
    call_id: callRecord.call_id,
    monday_item_id: callRecord.monday_item_id,
    status: callRecord.status,
    previous_status: previousStatus,
    caller_phone: callRecord.caller_phone_e164 || 'Unknown',
    caller_name: callRecord.caller_name,
    route_kind: callRecord.route_kind_current,
    source_queue: callRecord.main_queue_name || 'Unknown',
    source_queue_ext: callRecord.main_queue_ext || '',
    overflowed: callRecord.overflowed,
    overflow_queue: callRecord.overflow_queue_name,
    overflow_queue_ext: callRecord.overflow_queue_ext,
    answered_by: callRecord.answered_by_name,
    answered_by_ext: callRecord.answered_by_ext,
    ended_at: callRecord.ended_at_ms
      ? new Date(callRecord.ended_at_ms).toISOString()
      : undefined,
    duration_total_sec: callRecord.dur_total_sec,
    duration_talk_sec: callRecord.dur_talk_sec,
    duration_ring_sec: callRecord.dur_ring_sec,
    disposition: callRecord.disposition,
    recording_url: callRecord.recording_url,
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
  const { config, supabase, zapierFetch, mondayCreate, mondayUpdateStatus, mondayGetActionCallUrl, slackPost, now } = deps;
  const callId = event.call_id;
  const eventType = event.event_type;

  console.log(`[Step 1/8] Loading existing call state for ${callId}...`);
  const existingCall = await getCallRecord(supabase, callId);
  if (existingCall) {
    console.log(`  ✓ Found existing call: status=${existingCall.status}, route=${existingCall.route_kind_current}`);
  } else {
    console.log(`  ✓ No existing call found - this is a new call`);
  }

  console.log(`[Step 2/8] Checking state machine guards...`);
  if (!shouldApplyEvent(event, existingCall)) {
    console.log(`  ✗ Event rejected: out-of-order or duplicate (event_ts=${event.event_ts_ms}, rank=${EVENT_RANKS[eventType] || 0})`);
    console.log(`    Last processed: ts=${existingCall?.last_processed_event_ts_ms}, rank=${existingCall?.last_processed_rank}`);
    return;
  }
  console.log(`  ✓ Event accepted for processing`);

  console.log(`[Step 3/8] Classifying event route...`);
  const classification = await classifyEvent(supabase, event);
  console.log(`  ✓ Route classification: ${classification.routeKind}${classification.queueConfig ? ` (queue: ${classification.queueConfig.name})` : ''}`);

  console.log(`[Step 4/8] Building call record update...`);
  const previousStatus = existingCall?.status;
  const newStatus = mapEventToStatus(eventType, previousStatus);
  const update = buildCallUpdate(event, classification, existingCall, now());
  console.log(`  ✓ Status transition: ${previousStatus || 'NEW'} → ${newStatus}`);

  console.log(`[Step 5/8] Checking Monday.com integration...`);
  const isNewCall = !existingCall;
  const queueLabel = routeKindToQueueLabel(classification.routeKind);
  const shouldCreateMondayItem = isNewCall && queueLabel;

  if (shouldCreateMondayItem) {
    console.log(`  → Creating Monday item for new ${queueLabel} call...`);
    try {
      const mondayInput: MondayItemInput = {
        callerPhone: event.caller_phone_e164 || 'Unknown',
        callerName: event.caller_name,
        incomingDateIso: new Date(event.event_ts_ms).toISOString(),
        callStatus: 'RINGING',
        callQueue: queueLabel,
        source: classification.queueConfig?.name,
        zoomCallId: callId,
      };

      const mondayItemId = await mondayCreate(mondayInput);
      update.monday_item_id = mondayItemId;
      console.log(`  ✓ Monday item created: ${mondayItemId}`);
    } catch (error) {
      console.error(`  ✗ Monday item creation failed (non-blocking):`, error);
    }
  } else if (existingCall?.monday_item_id) {
    // Update Monday item status if status changed
    const mondayStatus = callStatusToMondayLabel(newStatus as CallStatus);
    const statusChanged = previousStatus !== newStatus;
    // Also update queue if route changed (e.g., MAIN → OVERFLOW)
    const routeChanged = existingCall.route_kind_current !== classification.routeKind;
    const newQueueLabel = routeChanged ? queueLabel : undefined;

    if (statusChanged && mondayStatus) {
      console.log(`  → Updating Monday item ${existingCall.monday_item_id} status to ${mondayStatus}${newQueueLabel ? ` (queue: ${newQueueLabel})` : ''}...`);
      try {
        await mondayUpdateStatus(existingCall.monday_item_id, mondayStatus, newQueueLabel);
        console.log(`  ✓ Monday item status updated`);
      } catch (error) {
        console.error(`  ✗ Monday item update failed (non-blocking):`, error);
      }
    } else {
      console.log(`  ✓ Monday item exists: ${existingCall.monday_item_id} (no status change)`);
    }
  } else {
    console.log(`  - Skipping Monday (route=${classification.routeKind}, isNewCall=${isNewCall})`);
  }

  console.log(`[Step 6/8] Checking Slack integration...`);
  const shouldPostSlack = queueLabel !== undefined; // Post for MAIN, OVERFLOW, ANSWERING_SERVICE routes

  if (shouldPostSlack && isNewCall) {
    // New call - create a new thread with Monday Action Call link
    console.log(`  → Posting new call to Slack...`);
    try {
      // Fetch the Action Call URL from the newly created Monday item
      // Wait for Monday automation to populate the Action Call link
      let actionCallUrl: string | undefined;
      if (update.monday_item_id) {
        try {
          // Wait 2 seconds for Monday automation to run
          await new Promise((resolve) => setTimeout(resolve, 2000));
          actionCallUrl = await mondayGetActionCallUrl(update.monday_item_id);
          console.log(`  ✓ Fetched Action Call URL: ${actionCallUrl || 'none'}`);
        } catch (err) {
          console.error(`  ✗ Failed to fetch Action Call URL:`, err);
        }
      }
      const slackMessage = formatNewCallMessage(
        event.caller_phone_e164 || 'Unknown',
        event.caller_name,
        classification.queueConfig?.name || classification.routeKind,
        classification.routeKind,
        actionCallUrl
      );
      const result = await slackPost(config.slackChannelId, slackMessage);
      if (result.ts) {
        update.slack_parent_ts = result.ts;
        console.log(`  ✓ Slack thread created: ${result.ts}`);
      }
    } catch (error) {
      console.error(`  ✗ Slack post failed (non-blocking):`, error);
    }
  } else if (existingCall?.slack_parent_ts && previousStatus !== newStatus) {
    // Existing call with thread - reply with status update
    console.log(`  → Posting status update to Slack thread...`);
    try {
      const slackMessage = formatStatusUpdateMessage(previousStatus, newStatus, {
        answeredBy: event.callee_name,
        duration: event.duration_sec,
        routeKind: classification.routeKind,
        queueName: classification.queueConfig?.name,
      });
      await slackPost(config.slackChannelId, slackMessage, existingCall.slack_parent_ts);
      console.log(`  ✓ Slack thread updated`);
    } catch (error) {
      console.error(`  ✗ Slack reply failed (non-blocking):`, error);
    }
  } else {
    console.log(`  - Skipping Slack (no thread or no status change)`);
  }

  console.log(`[Step 7/8] Saving call record to Supabase...`);
  const updatedCall = await saveCallRecord(supabase, callId, update, existingCall);
  console.log(`  ✓ Call record saved: status=${updatedCall.status}, monday_item_id=${updatedCall.monday_item_id || 'none'}, slack_ts=${updatedCall.slack_parent_ts || 'none'}`);

  console.log(`[Step 8/8] Notifying Zapier...`);
  const shouldNotifyZapier =
    updatedCall.route_kind_current === 'MAIN' ||
    updatedCall.route_kind_current === 'OVERFLOW' ||
    updatedCall.route_kind_current === 'ANSWERING_SERVICE';

  if (shouldNotifyZapier) {
    const zapierPayload = buildZapierPayload(updatedCall, previousStatus);
    console.log(`  → Sending to Zapier: ${previousStatus || 'NEW'} → ${updatedCall.status}`);
    try {
      await zapierFetch(zapierPayload);
      console.log(`  ✓ Zapier notified successfully`);
    } catch (error) {
      // Log but don't throw - Zapier failures shouldn't block the queue
      console.error(`  ✗ Zapier notification failed (non-blocking):`, error);
    }
  } else {
    console.log(`  - Skipping Zapier notification (route=${updatedCall.route_kind_current})`);
  }

  console.log(`[Complete] Event processed: ${eventType} for call ${callId}`);
}

// ===================
// Create Handler with Dependencies
// ===================
export function createProcessorHandler(deps: ProcessorDependencies) {
  return async function handler(sqsEvent: SQSEvent): Promise<SQSBatchResponse> {
    console.log('=== PROCESSOR START ===');
    // Log full SQS event for replay/debugging
    console.log('SQS_EVENT_PAYLOAD:', JSON.stringify(sqsEvent, null, 2));
    const batchItemFailures: SQSBatchItemFailure[] = [];

    for (const record of sqsEvent.Records) {
      try {
        const event = JSON.parse(record.body) as NormalizedEvent;
        console.log(`Processing: ${event.event_type} for call ${event.call_id}`);
        console.log('NORMALIZED_EVENT:', JSON.stringify(event, null, 2));
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
// Real Zapier Fetch
// ===================
async function realZapierFetch(
  webhookUrl: string,
  payload: ZapierStateChangePayload
): Promise<{ ok: boolean }> {
  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Zapier webhook failed: ${response.status} ${response.statusText}`);
  }

  return { ok: true };
}

// ===================
// Default Handler (Lambda Entry Point)
// ===================
const config = loadConfig();
const supabase = getSupabaseClient();

export const handler = createProcessorHandler({
  config,
  supabase,
  zapierFetch: (payload) => realZapierFetch(config.zapierWebhookUrl, payload),
  mondayCreate: (input) => createMondayItem(config.mondayApiToken, input),
  mondayUpdateStatus: (itemId, status, queue) => updateMondayItemStatus(config.mondayApiToken, itemId, status, queue),
  mondayGetActionCallUrl: (itemId) => getMondayItemActionCallUrl(config.mondayApiToken, itemId),
  slackPost: (channel, text, threadTs) =>
    postSlackMessage(config.slackBotToken, { channel, text, thread_ts: threadTs, unfurl_links: false }),
  now: () => Date.now(),
});
