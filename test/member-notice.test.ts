import type { SQSEvent } from 'aws-lambda';
import { afterEach, expect, it, vi } from 'vitest';
import type { ProcessorDependencies } from '../src/processor';
import { loadConfig, NormalizedEvent } from '../src/types';
import { deferNotice, mightBeBridged } from '../src/bridge-notices';
vi.mock('../src/bridge-notices', () => ({ mightBeBridged: vi.fn(), deferNotice: vi.fn() }));
vi.mock('../src/supabase', () => ({ getSupabaseClient: () => ({}) }));
afterEach(() => vi.clearAllMocks());

it.each([true, false])('posts one canonical item and checks an answered member webhook for early notice ownership (%s)', async bridge => {
  const { createProcessorHandler } = await import('../src/processor');
  const event: NormalizedEvent = { event_id: 'member-answer', event_type: 'phone.callee_answered',
    event_ts_ms: Date.now(), call_id: '1234567', ringing_start_time_ms: Date.now() - 1500,
    caller_phone_e164: '+12125550101', callee_phone_e164: '+12125550102',
    callee_extension_type: 'user', forwarded_by_extension_type: 'callQueue', forwarded_by_extension_number: '8001' };
  const insert = vi.fn(async () => ({ error: null }));
  const database = { from: (name: string) => ({ insert,
    select: () => ({ eq: () => ({ single: () => name === 'rb_calls' ? { data: null, error: { code: 'PGRST116' } } :
      { data: { name: '111', route_kind: 'MAIN', enabled: true }, error: null } }) }) }) };
  vi.mocked(mightBeBridged).mockResolvedValue(bridge);
  const deps: ProcessorDependencies = { config: loadConfig(), supabase: database as unknown as ProcessorDependencies['supabase'],
    mondayCreate: vi.fn(async () => '123'), mondayUpdateStatus: vi.fn(), slackPost: vi.fn(async () => ({ ok: true, ts: '1.99' })),
    now: Date.now, lifxOff: vi.fn() };
  const message = { Records: [{ body: JSON.stringify(event), attributes: { SentTimestamp: String(event.event_ts_ms),
    ApproximateReceiveCount: '1' } }] } as SQSEvent;
  expect(await createProcessorHandler(deps)(message)).toEqual({ batchItemFailures: [] });
  expect(deps.mondayCreate).toHaveBeenCalledOnce();
  expect(deps.mondayCreate).toHaveBeenCalledWith(expect.objectContaining({ zoomCallId: event.call_id }));
  expect(mightBeBridged).toHaveBeenCalledWith(event);
  expect(deferNotice).toHaveBeenCalledTimes(bridge ? 1 : 0);
  expect(deps.slackPost).toHaveBeenCalledTimes(bridge ? 0 : 1);
  expect(insert).toHaveBeenCalledWith(expect.objectContaining({ call_id: event.call_id, monday_item_id: '123' }));
});
