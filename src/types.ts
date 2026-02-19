// ===================
// Zoom Webhook Types
// ===================

export interface ZoomParty {
  name?: string;
  extension_type?: string;
  extension_number?: string | number;
  extension_id?: string;
  user_id?: string;
  phone_number?: string;
  device_type?: string;
  device_name?: string;
  connection_type?: string;
}

export interface ZoomPayload {
  event: string;
  event_ts: number;
  payload: {
    plainToken?: string;
    account_id?: string;
    object: {
      call_id: string;
      caller?: ZoomParty;
      callee?: ZoomParty;
      forwarded_by?: ZoomParty;
      original_caller?: { name?: string; phone_number?: string };
      ringing_start_time?: string;
      answer_start_time?: string;
      call_end_time?: string;  // Zoom uses call_end_time, not end_time
      handup_result?: string;  // "Answered by Other Member", "Call connected", etc.
      duration?: number;
    };
  };
}

// ===================
// DynamoDB Record Types
// ===================

export type CallStatus = 'NEW' | 'RINGING' | 'ANSWERED' | 'MISSED' | 'ENDED';
export type RouteKind = 'MAIN' | 'OVERFLOW' | 'ANSWERING_SERVICE' | 'USER_DIRECT' | 'UNKNOWN';
export type SpecialNumberKind = 'ANSWERING_SERVICE' | 'VIP' | 'SPAM' | 'OTHER';

export interface CallRecord {
  call_id: string;
  created_at_ms: number;
  last_event_ts_ms: number;
  last_processed_event_ts_ms: number;
  last_processed_rank: number;
  status: CallStatus;
  caller_phone_e164?: string;
  caller_name?: string;
  main_queue_ext?: string;
  main_queue_name?: string;
  overflowed: boolean;
  overflow_queue_ext?: string;
  overflow_queue_name?: string;
  route_kind_current: RouteKind;
  answered_by_zoom_user_id?: string;
  answered_by_ext?: string;
  answered_by_name?: string;
  ended_at_ms?: number;
  // Monday.com integration
  monday_item_id?: string;
  // Slack integration
  slack_parent_ts?: string;
  // Optional analytics fields
  dur_total_sec?: number;
  dur_talk_sec?: number;
  dur_ring_sec?: number;
  disposition?: string;
  recording_url?: string;
}

export interface IdempotencyRecord {
  event_id: string;
  expires_at: number; // TTL in epoch seconds
  processed_at_ms: number;
}

export interface CallQueueConfig {
  queue_ext: string;
  name: string;
  route_kind: 'MAIN' | 'OVERFLOW' | 'OTHER';
  enabled: boolean;
}

export interface SpecialNumberConfig {
  phone_e164: string;
  kind: SpecialNumberKind;
  label: string;
  enabled: boolean;
}

// ===================
// SQS Message Types
// ===================

export interface NormalizedEvent {
  event_id: string;
  event_type: string;
  event_ts_ms: number;
  call_id: string;
  // Caller info
  caller_phone_e164?: string;
  caller_name?: string;
  // Callee info (on answered event, this IS the person who answered)
  callee_extension_type?: string;
  callee_extension_number?: string;
  callee_phone_e164?: string;
  callee_user_id?: string;
  callee_name?: string;
  // Queue routing
  forwarded_by_extension_type?: string;
  forwarded_by_extension_number?: string;
  forwarded_by_name?: string;
  // Timing
  ringing_start_time_ms?: number;
  answer_start_time_ms?: number;
  end_time_ms?: number;
  duration_sec?: number;
}

// ===================
// Zapier Webhook Types
// ===================

export interface ZapierStateChangePayload {
  // Event metadata
  event_type: 'state_change';
  triggered_at: string; // ISO timestamp

  // Call identification
  call_id: string;
  monday_item_id?: string;

  // Current state (what Zapier should display)
  status: CallStatus;
  previous_status?: CallStatus;

  // Caller info
  caller_phone: string;
  caller_name?: string;

  // Routing info
  route_kind: RouteKind;
  source_queue: string;
  source_queue_ext: string;
  overflowed: boolean;
  overflow_queue?: string;
  overflow_queue_ext?: string;

  // Outcome info (populated when available)
  answered_by?: string;
  answered_by_ext?: string;
  ended_at?: string;

  // Analytics (populated on call_log_completed)
  duration_total_sec?: number;
  duration_talk_sec?: number;
  duration_ring_sec?: number;
  disposition?: string;
  recording_url?: string;
}

// ===================
// Call History Types
// ===================

export interface CallLogEntry {
  id: string;
  call_id: string;
  call_path_id?: string;
  direction?: string;
  event?: string;
  result?: string;
  node?: number;
  caller_name?: string;
  caller_did_number?: string;
  caller_number_type?: string;
  callee_ext_id?: string;
  callee_ext_number?: string;
  callee_ext_type?: string;
  callee_name?: string;
  callee_email?: string;
  operator_ext_id?: string;
  operator_ext_number?: string;
  operator_ext_type?: string;
  operator_name?: string;
  start_time?: string;
  end_time?: string;
  // Zoom sends "waiting_time" and "duration", not "wait_time" and "talk_time"
  waiting_time?: number;  // Zoom's actual field name for wait time
  duration?: number;      // Zoom's actual field name for talk time
  // Keep old field names for backward compatibility
  wait_time?: number;
  talk_time?: number;
  hold_time?: number;
}

export interface CallHistoryPayload {
  event: 'phone.callee_call_log_completed';
  event_ts: number;
  payload: {
    account_id?: string;
    object: {
      call_logs: CallLogEntry[];
      user_id?: string;
    };
  };
}

// ===================
// Event Processing
// ===================

export const EVENT_RANKS: Record<string, number> = {
  'phone.callee_ringing': 10,
  'phone.callee_answered': 20,
  'phone.callee_missed': 30,
  'phone.callee_ended': 40,
  'phone.call_log_completed': 50,
};

export function mapEventToStatus(eventType: string, currentStatus?: CallStatus): CallStatus {
  switch (eventType) {
    case 'phone.callee_ringing':
      return 'RINGING';
    case 'phone.callee_answered':
      return 'ANSWERED';
    case 'phone.callee_missed':
      // Don't regress from ANSWERED to MISSED
      return currentStatus === 'ANSWERED' ? 'ANSWERED' : 'MISSED';
    case 'phone.callee_ended':
    case 'phone.call_log_completed':
      return 'ENDED';
    default:
      return currentStatus || 'NEW';
  }
}

// ===================
// Environment Config
// ===================

export interface Config {
  supabaseUrl: string;
  supabaseServiceKey: string;
  eventsQueueUrl?: string; // Only for ingress
  zoomWebhookSecret: string;
  zapierWebhookUrl: string;
  mondayApiToken: string;
  slackBotToken: string;
  slackChannelId: string;
  idempotencyTtlSeconds: number;
}

export function loadConfig(): Config {
  return {
    supabaseUrl: process.env.SUPABASE_URL!,
    supabaseServiceKey: process.env.SUPABASE_SERVICE_KEY!,
    eventsQueueUrl: process.env.EVENTS_QUEUE_URL,
    zoomWebhookSecret: process.env.ZOOM_WEBHOOK_SECRET!,
    zapierWebhookUrl: process.env.ZAPIER_WEBHOOK_URL!,
    mondayApiToken: process.env.MONDAY_API_TOKEN!,
    slackBotToken: process.env.SLACK_BOT_TOKEN!,
    slackChannelId: process.env.SLACK_CHANNEL_ID!,
    idempotencyTtlSeconds: parseInt(process.env.IDEMPOTENCY_TTL_SECONDS || '86400', 10),
  };
}
