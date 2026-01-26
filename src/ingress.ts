import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createHmac, createHash } from 'crypto';
import parsePhoneNumber, { CountryCode } from 'libphonenumber-js';
import { ZoomPayload, NormalizedEvent, loadConfig, Config } from './types';
import { getSupabaseClient, SupabaseClientType } from './supabase';

// ===================
// Zoom CRC Challenge Handler
// ===================
export function handleCrcChallenge(
  plainToken: string,
  secret: string
): APIGatewayProxyResultV2 {
  const hash = createHmac('sha256', secret).update(plainToken).digest('hex');

  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      plainToken,
      encryptedToken: hash,
    }),
  };
}

// ===================
// Zoom Signature Validation
// ===================
export function validateZoomSignature(
  timestamp: string | undefined,
  signature: string | undefined,
  body: string | undefined,
  secret: string
): boolean {
  if (!timestamp || !signature || !body) {
    return false;
  }

  const message = `v0:${timestamp}:${body}`;
  const expectedSignature = `v0=${createHmac('sha256', secret).update(message).digest('hex')}`;

  return signature === expectedSignature;
}

// ===================
// Compute Stable Event ID
// ===================
export function computeEventId(payload: ZoomPayload): string {
  const obj = payload.payload.object;
  const callee = obj.callee || {};
  const fwd = obj.forwarded_by || {};

  // Build unique signature from call context
  const data = [
    obj.call_id,
    payload.event,
    payload.event_ts,
    obj.caller?.phone_number || 'none',
    `${callee.extension_type || 'none'}:${callee.extension_number ?? callee.extension_id ?? 'none'}`,
    `${fwd.extension_type || 'none'}:${fwd.extension_number ?? 'none'}`,
  ].join('|');

  return createHash('sha256').update(data).digest('hex');
}

// ===================
// Normalize Phone to E.164 using libphonenumber-js
// ===================
export function normalizePhoneE164(
  phone?: string,
  defaultCountry: CountryCode = 'US'
): string | undefined {
  if (!phone?.trim()) return undefined;
  try {
    const parsed = parsePhoneNumber(phone, defaultCountry);
    return parsed?.isValid() ? parsed.number : undefined;
  } catch {
    return undefined;
  }
}

// ===================
// Normalize Zoom Payload to Event
// ===================
function toStr(val?: string | number): string | undefined {
  return val != null ? String(val) : undefined;
}

function toMs(isoDate?: string): number | undefined {
  return isoDate ? new Date(isoDate).getTime() : undefined;
}

export function normalizePayload(payload: ZoomPayload): NormalizedEvent {
  const obj = payload.payload.object;

  return {
    event_id: computeEventId(payload),
    event_type: payload.event,
    event_ts_ms: payload.event_ts,
    call_id: obj.call_id,
    // Caller
    caller_phone_e164: normalizePhoneE164(obj.caller?.phone_number),
    caller_name: obj.caller?.name,
    // Callee (on answered event, this IS who answered)
    callee_extension_type: obj.callee?.extension_type,
    callee_extension_number: toStr(obj.callee?.extension_number),
    callee_phone_e164: normalizePhoneE164(obj.callee?.phone_number),
    callee_user_id: obj.callee?.user_id,
    callee_name: obj.callee?.name,
    // Queue routing
    forwarded_by_extension_type: obj.forwarded_by?.extension_type,
    forwarded_by_extension_number: toStr(obj.forwarded_by?.extension_number),
    forwarded_by_name: obj.forwarded_by?.name,
    // Timing
    ringing_start_time_ms: toMs(obj.ringing_start_time),
    answer_start_time_ms: toMs(obj.answer_start_time),
    end_time_ms: toMs(obj.call_end_time),
    duration_sec: obj.duration,
  };
}

// ===================
// Idempotency Check (Light Gate) - Supabase
// ===================
async function tryClaimIdempotency(
  supabase: SupabaseClientType,
  eventId: string,
  ttlSeconds: number
): Promise<boolean> {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();

  const { error } = await supabase.from('rb_idempotency').insert({
    event_id: eventId,
    expires_at: expiresAt,
  });

  if (error) {
    // Unique constraint violation = duplicate
    if (error.code === '23505') {
      return false;
    }
    throw error;
  }

  return true;
}

// ===================
// Dependencies for Testing
// ===================
export interface IngressDependencies {
  config: Config;
  supabase: SupabaseClientType;
  sqsClient: SQSClient;
}

// ===================
// Create Handler with Dependencies
// ===================
export function createIngressHandler(deps: IngressDependencies) {
  const { config, supabase, sqsClient } = deps;

  return async function handler(
    event: APIGatewayProxyEventV2
  ): Promise<APIGatewayProxyResultV2> {
    console.log('=== INGRESS START ===');

    try {
      const body = JSON.parse(event.body || '{}') as ZoomPayload;

      // DEBUG: Log full raw payload from Zoom
      console.log('DEBUG_RAW_PAYLOAD:', JSON.stringify(body, null, 2));

      // Handle Zoom CRC challenge (endpoint validation)
      if (body.event === 'endpoint.url_validation') {
        console.log('Handling CRC challenge');
        return handleCrcChallenge(body.payload.plainToken!, config.zoomWebhookSecret);
      }

      // Validate Zoom signature
      if (
        !validateZoomSignature(
          event.headers['x-zm-request-timestamp'],
          event.headers['x-zm-signature'],
          event.body,
          config.zoomWebhookSecret
        )
      ) {
        console.error('Invalid Zoom signature');
        return { statusCode: 401, body: 'Unauthorized' };
      }

      // Check for call_id
      const callId = body.payload?.object?.call_id;
      if (!callId) {
        console.log('No call_id in payload, acknowledging but not processing');
        return { statusCode: 200, body: JSON.stringify({ ok: true, skipped: 'no_call_id' }) };
      }

      // Normalize the payload
      const normalizedEvent = normalizePayload(body);

      // DEBUG: Log normalized event
      console.log('DEBUG_NORMALIZED_EVENT:', JSON.stringify(normalizedEvent, null, 2));

      // Light idempotency gate (prevents duplicate enqueues)
      const claimed = await tryClaimIdempotency(
        supabase,
        normalizedEvent.event_id,
        config.idempotencyTtlSeconds
      );

      if (!claimed) {
        console.log('Duplicate event, already processed:', normalizedEvent.event_id);
        return { statusCode: 200, body: JSON.stringify({ ok: true, duplicate: true }) };
      }

      // Enqueue to SQS FIFO
      await sqsClient.send(
        new SendMessageCommand({
          QueueUrl: config.eventsQueueUrl,
          MessageBody: JSON.stringify(normalizedEvent),
          MessageGroupId: normalizedEvent.call_id, // FIFO ordering per call
          MessageDeduplicationId: normalizedEvent.event_id, // Secondary dedupe
        })
      );

      console.log('Event enqueued successfully:', normalizedEvent.event_id);

      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, event_id: normalizedEvent.event_id }),
      };
    } catch (error) {
      console.error('Error in ingress handler:', error);
      // Return 200 to prevent Zoom from retrying (we'll handle errors internally)
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: false, error: 'Internal error' }),
      };
    }
  };
}

// ===================
// Default Handler (Lambda Entry Point)
// ===================
const config = loadConfig();
const supabase = getSupabaseClient();
const sqsClient = new SQSClient({});

export const handler = createIngressHandler({
  config,
  supabase,
  sqsClient,
});
