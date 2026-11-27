import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeLeg, linkFirstNumber, matchQueueArrival, QueueArrival } from '../src/first-number-link';
import { incomingMessage } from '../src/incoming-alerts';
import { singleQueueSettings } from '../src/twilio-entry';
import { forwardedTo, readBridgeLegs, readZoomHistory } from '../scripts/link-first-number';

const bridge = '+12125550101', landing = '+12125550102', original = '+18555550100';
const queue = '8001', caller = '+12125550123', ts = '12345.000100';
const settings = singleQueueSettings(bridge, landing, original, { [original]: 'queue111' });
const start = Date.parse('2026-01-02T00:00:01Z');
const leg: BridgeLeg = { childSid: 'CA' + 'c'.repeat(32), parentSid: 'CA' + 'a'.repeat(32), caller, landing, initiated: start };
const arrival: QueueArrival = { call_id: '1001', start_time: new Date(start + 1000).toISOString(), direction: 'inbound',
  end_time: new Date(start + 30000).toISOString(), caller_did_number: caller, callee_did_number: landing,
  callee_ext_type: 'call_queue', callee_ext_number: queue, call_result: 'answered' };
const outer = { ...arrival, call_id: '991', call_history_uuid: 'history-991', callee_did_number: original,
  callee_ext_type: 'user', start_time: new Date(start - 2000).toISOString() };
const alert = { state: 'posted', route: 'queue111', channel: 'test', ts, entry: bridge, childSid: leg.childSid,
  caller, landing, initiated: start };
function fixture(initial?: string) {
  let item = initial, claimed = false;
  const message = { ts, text: incomingMessage({ route: 'queue111', callerNumber: caller }),
    metadata: { event_type: 'roofbuddy_incoming_call', event_payload: { parent_call_sid: leg.parentSid } } };
  const create = vi.fn(async () => { item = '77'; return item; });
  const services = {
    itemForZoomCall: vi.fn(async () => item), originalMessage: vi.fn(async () => ({ ...message })),
    permalinkMatches: vi.fn(async () => true), editRecorded: vi.fn(async () => false), recordEdit: vi.fn(async () => {}),
    workflowOwner: vi.fn(async (): Promise<{ slack_parent_ts?: string; monday_item_id?: string } | null> => null),
    forwardedTo: vi.fn(async () => true), reserve: vi.fn(async () => {}),
    createOnce: vi.fn(async () => { if (claimed) return; claimed = true; return create(); }),
    bindItem: vi.fn(async () => {}), edit: vi.fn(async (_ch: string, _ts: string, text: string) => {
      message.text = text; return { ok: true, ts }; }),
  };
  const run = (apply = true, legs = [leg], rows: QueueArrival[] = [arrival, outer], receipt = alert) =>
    linkFirstNumber(leg, legs, rows, receipt, settings, 'test', queue, services, apply);
  return { run, services, create, message };
}

describe('the first-number bridge', () => {
  it('finds one existing item and edits the exact original alert in the existing queue format', async () => {
    const f = fixture('77');
    expect(await f.run()).toBe('linked');
    expect(f.services.itemForZoomCall).toHaveBeenCalledWith('1001');
    expect(f.create).not.toHaveBeenCalled();
    expect(f.services.edit).toHaveBeenCalledWith('test', ts, incomingMessage({ route: 'queue111', callerNumber: caller, mondayItemId: '77' }));
    expect(await f.run()).toBe('already-linked');
    expect(f.services.edit).toHaveBeenCalledTimes(1);
  });
  it('handles simultaneous member events, two workers and a later redelivery', async () => {
    const f = fixture();
    const rows = [outer, arrival, { ...arrival }, { ...arrival, callee_ext_type: 'user' }];
    await Promise.all([f.run(true, [leg], rows), f.run(true, [leg], rows)]);
    expect(await f.run()).toBe('already-linked');
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.services.createOnce).toHaveBeenCalledWith(leg.parentSid, expect.objectContaining({
      numberCalled: original, zoomCallId: arrival.call_id, callQueue: 'MAIN', callStatus: 'ANSWERED' }));
    expect(f.message.text).toContain('111 (MAIN)');
  });
  it('recovers the same item after a lost create response', async () => {
    const f = fixture();
    f.create.mockImplementationOnce(async () => {
      f.services.itemForZoomCall.mockResolvedValue('77');
      throw Error('connection lost');
    });
    await expect(f.run()).rejects.toThrow('connection lost');
    expect(await f.run()).toBe('linked');
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('repairs a failed edit and never creates another Monday item', async () => {
    const f = fixture();
    f.services.edit.mockRejectedValueOnce(Error('temporary'));
    await expect(f.run()).rejects.toThrow('temporary');
    expect(await f.run()).toBe('linked');
    expect(f.create).toHaveBeenCalledTimes(1);
  });
  it('keeps preview read-only for existing and missing items', async () => {
    for (const item of [undefined, '77']) {
      const f = fixture(item);
      expect(await f.run(false)).toBe(item ? 'ready' : 'would-create-item');
      for (const key of ['reserve','bindItem','createOnce','edit'] as const) expect(f.services[key]).not.toHaveBeenCalled();
    }
  });
  it('holds a same-caller collision on either side, including a second dial attempt', async () => {
    const f = fixture();
    const other = { ...leg, childSid: 'CA' + 'd'.repeat(32) };
    expect(await f.run(true,[leg,other])).toBe('unresolved-call');
    expect(await f.run(true,[leg,{ ...other,parentSid: 'CA'+'e'.repeat(32) }])).toBe('unresolved-call');
    expect(await f.run(true,[leg],[outer,arrival,{ ...arrival,call_id:'1002' }])).toBe('unresolved-call');
    expect(await f.run(true,[leg],[outer,arrival,{ ...outer,call_id:'992' }])).toBe('unverified-origin');
    expect(f.services.reserve).not.toHaveBeenCalled();
  });
  it('separates repeat calls and simultaneous different callers', () => {
    for (const other of [{...leg,initiated:start+60000}, {...leg,caller:'+12125550155'}]) {
      const distinct = {...other,parentSid:'CA'+'f'.repeat(32),childSid:'CA'+'e'.repeat(32)};
      expect(matchQueueArrival(leg,[leg,distinct],[arrival],landing,queue)).toBe('1001');
    }
  });
  it('holds calls to other lines, direct bridge calls, hidden caller IDs and missing proof of forwarding', async () => {
    const f = fixture();
    expect(await f.run(true,[leg],[arrival])).toBe('unverified-origin');
    for (const change of [{ callee_did_number: original },{ caller_did_number: 'anonymous' },
      { callee_ext_number: '8123' },{ direction:'outbound' },{ callee_ext_type:'user' }]) {
      expect(await f.run(true,[leg],[outer,{ ...arrival,...change }])).toBe('unresolved-call');
    }
    f.services.forwardedTo.mockResolvedValue(false);
    expect(await f.run()).toBe('unverified-origin');
    expect(f.services.createOnce).not.toHaveBeenCalled();
  });
  it('preserves another Slack message or a conflicting existing link', async () => {
    const f = fixture('77');
    f.message.text += '\nA human edit';
    expect(await f.run()).toBe('message-changed');
    f.message.metadata.event_payload.parent_call_sid='CA'+'f'.repeat(32);
    expect(await f.run()).toBe('unverified-message');
    expect(await f.run(true,[leg],[outer,arrival],{...alert,channel:'other'})).toBe('unverified-alert');
    expect(f.services.reserve).not.toHaveBeenCalled();
  });
  it('does not mutate anything on a duplicate board result or conflicting reservation', async () => {
    const f = fixture();
    f.services.itemForZoomCall.mockRejectedValueOnce(Error('two matching board rows'));
    await expect(f.run()).rejects.toThrow('two matching');
    f.services.reserve.mockRejectedValueOnce(Error('conflicting parent'));
    await expect(f.run()).rejects.toThrow('conflicting parent');
    expect(f.create).not.toHaveBeenCalled(); expect(f.services.edit).not.toHaveBeenCalled();
  });
  it('leaves the existing workflow alone if it already posted a different Slack parent', async () => {
    const f = fixture();
    f.services.workflowOwner.mockResolvedValue({ slack_parent_ts:'12345.000999' });
    expect(await f.run()).toBe('workflow-conflict');
    expect(f.services.reserve).not.toHaveBeenCalled();
  });
});

afterEach(() => vi.unstubAllGlobals());
describe('provider evidence', () => {
  it('reads every Zoom page, including transitional payloads', async () => {
    const fetch = vi.fn().mockResolvedValueOnce(Response.json({call_history:[outer],next_page_token:'more'}))
      .mockResolvedValueOnce(Response.json({call_logs:[arrival],next_page_token:''}));
    vi.stubGlobal('fetch',fetch);
    expect(await readZoomHistory('test','2026-01-01','2026-01-03')).toEqual([outer,arrival]);
  });
  it('rejects incomplete Zoom pagination', async () => {
    vi.stubGlobal('fetch',vi.fn(async()=>Response.json({call_history:[arrival],next_page_token:'stuck'})));
    await expect(readZoomHistory('test','2026-01-01','2026-01-03')).rejects.toThrow('pagination');
  });
  it('uses the history UUID and requires the original Zoom call to show the private bridge', async () => {
    const fetch=vi.fn().mockResolvedValueOnce(Response.json({call_id:outer.call_id,call_elements:[{call_id:outer.call_id,callee_did_number:bridge}]}))
      .mockResolvedValueOnce(Response.json({call_id:outer.call_id,call_elements:[{call_id:'other',callee_did_number:bridge}]}));
    vi.stubGlobal('fetch',fetch);
    expect(await forwardedTo('test',outer,bridge)).toBe(true);
    expect(fetch.mock.calls[0][0].pathname).toMatch(/history-991$/);
    expect(await forwardedTo('test',outer,bridge)).toBe(false);
  });
  it('rejects an untrusted Twilio pagination destination before sending credentials', async () => {
    const fetch=vi.fn(async()=>Response.json({calls:[],next_page_uri:'https://example.com/next'}));
    vi.stubGlobal('fetch',fetch);
    await expect(readBridgeLegs(new URL('https://api.twilio.com/test'),'test',landing,['2026-01-02'])).rejects.toThrow('Unexpected Twilio page');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
