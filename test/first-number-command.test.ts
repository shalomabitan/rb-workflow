import { afterEach, expect, it, vi } from 'vitest';
import { runFirstNumber, zoomToken } from '../scripts/link-first-number';
import { incomingMessage } from '../src/incoming-alerts';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it('runs preview, apply and redelivery through the command entry point with isolated provider APIs', async () => {
  const account = 'AC' + 'a'.repeat(32), parent = 'CA' + 'b'.repeat(32), child = 'CA' + 'c'.repeat(32);
  const caller = '+12125550101', bridge = '+12125550102', landing = '+12125550103', original = '+18555550100';
  const start = Date.now() - 180000, date = new Date(start).toISOString().slice(0,10), ts = '12345.000100';
  const config = { firstPublicNumber: original, advertised: { [original]: 'queue111' },
    ingress: { [bridge]: 'queue111' }, destinations: { queue111: landing } };
  for (const [key, val] of Object.entries({ ENTRY_SETTINGS: JSON.stringify(config), FIRST_QUEUE_EXTENSION: '8001',
    SLACK_CHANNEL_ID: 'test-channel', TWILIO_ACCOUNT_SID: account, TWILIO_SYNC_SERVICE_SID: 'IS' + 'a'.repeat(32),
    TWILIO_API_KEY: 'test-key', TWILIO_API_SECRET: 'test-secret', MONDAY_API_TOKEN: 'test-monday',
    SLACK_BOT_TOKEN: 'test-slack', SUPABASE_URL: 'https://db.example.test', SUPABASE_SERVICE_KEY: 'test-db',
    ZOOM_CREDENTIAL_PARAMETER: '', ZOOM_CLIENT_ID: 'test-client', ZOOM_CLIENT_SECRET: 'test-secret', ZOOM_ACCOUNT_ID: 'test-account' })) vi.stubEnv(key,val);
  const zoomRow = { call_id: '101', call_history_uuid: 'inner', caller_did_number: caller, callee_did_number: landing,
    direction: 'inbound', callee_ext_number: '8001', callee_ext_type: 'call_queue', start_time: new Date(start + 1000).toISOString(),
    end_time: new Date(start + 27000).toISOString(), call_result: 'answered' };
  const zoomOrigin = { ...zoomRow, call_id: '100', call_history_uuid: 'origin', callee_did_number: original,
    start_time: new Date(start - 2000).toISOString() };
  let item: string | undefined, edits = 0, creates = 0;
  let record: Record<string,unknown> | undefined;
  const message = { ts, text: incomingMessage({ route:'queue111', callerNumber:caller }),
    metadata: { event_type:'roofbuddy_incoming_call', event_payload:{parent_call_sid:parent} } };
  const docs = new Map<string,unknown>([['incoming-' + parent, { route:'queue111', state:'posted', ts, channel:'test-channel',
    entry:bridge, landing, caller, childSid:child, initiated:start, receipt: { parentSid:parent, channel:'test-channel', ts, text:message.text } }]]);
  const json = (value: unknown, status=200) => Response.json(value,{status});
  const provider = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method || 'GET';
    if (url.hostname === 'zoom.us') return json({access_token:'test-zoom',scope:'phone:read:list_call_logs:admin phone:read:call_log:admin'});
    if (url.hostname === 'api.zoom.us') {
      return url.pathname.endsWith('/origin') ? json({call_id:'100',call_elements:[{call_id:'100',callee_did_number:bridge}]}) :
        json({next_page_token:'',call_history:[zoomRow,zoomOrigin]});
    }
    if (url.hostname === 'api.twilio.com') {
      expect(url.searchParams.get('To')).toBe(landing);
      return json({next_page_uri:null,calls:url.searchParams.get('StartTime') === date ? [{sid:child,parent_call_sid:parent,from:caller,to:landing,
        direction:'outbound-dial',date_created:new Date(start).toISOString(),end_time:zoomRow.end_time}] : []});
    }
    if (url.hostname === 'sync.twilio.com') {
      if (method === 'POST') {
        const form=init!.body as URLSearchParams, key=form.get('UniqueName')!;
        if (docs.has(key)) return json({},409);
        docs.set(key,JSON.parse(form.get('Data')!)); return json({},201);
      }
      const key = url.pathname.split('/').at(-1)!;
      return docs.has(key) ? json({data:docs.get(key)}) : json({},404);
    }
    if (url.hostname === 'api.monday.com') {
      const payload=JSON.parse(String(init!.body));
      if (payload.query.includes('mutation')) {
        expect(new Headers(init?.headers).get('Idempotency-Key')).toMatch(/-101$/);
        expect(JSON.parse(payload.variables.columnValues).text_mkyxh5fw).toBe('101');
        creates++; item='77'; return json({data:{create_item:{id:item}}});
      }
      expect(payload.variables.v).toBe('101');
      return json({data:{items_page_by_column_values:{cursor:null,items:item?[{id:item}]:[]}}});
    }
    if (url.hostname === 'slack.com') {
      if (url.pathname.endsWith('/chat.update')) {
        const edit=JSON.parse(String(init!.body));
        expect([edit.channel,edit.ts]).toEqual(['test-channel',ts]);
        edits++; message.text=edit.text; return json({ok:true,ts});
      }
      expect(url.pathname).toBe('/api/chat.getPermalink');
      return json({ok:true,channel:'test-channel',permalink:'https://example.slack.com/archives/test-channel/p'+ts.replace('.','')});
    }
    if (url.hostname === 'db.example.test' && url.pathname === '/rest/v1/rb_calls') {
      if (method === 'POST') { record ??= JSON.parse(String(init?.body)); return new Response(null,{status:201}); }
      if (method === 'PATCH') {
        const update=JSON.parse(String(init?.body));
        if (record && Object.keys(update).every(key=>record![key]==null)) Object.assign(record,update);
        return new Response(null,{status:204});
      }
      const single=new Headers(init?.headers).get('Accept')?.includes('vnd.pgrst.object');
      return json(single ? record : record ? [record] : []);
    }
    throw Error('Unexpected provider in isolated test: ' + url.hostname);
  });
  vi.stubGlobal('fetch',provider);
  expect(await runFirstNumber([date])).toEqual({'would-create-item':1});
  expect(record).toBeUndefined(); expect(docs.size).toBe(1);
  expect(await runFirstNumber([date,'--apply'])).toEqual({linked:1});
  expect(await runFirstNumber([date,'--apply'])).toEqual({'already-linked':1});
  expect(creates).toBe(1); expect(edits).toBe(1);
  expect(record).toMatchObject({call_id:'101',slack_parent_ts:ts,monday_item_id:'77'});
});

it('rejects a broader Zoom grant', async () => {
  vi.stubEnv('ZOOM_CREDENTIAL_PARAMETER', '');
  for (const name of ['ZOOM_ACCOUNT_ID','ZOOM_CLIENT_ID','ZOOM_CLIENT_SECRET']) vi.stubEnv(name,'test');
  vi.stubGlobal('fetch',vi.fn(async()=>Response.json({access_token:'test',
    scope:'phone:read:list_call_logs:admin phone:read:call_log:admin phone:read:call_recording:admin'})));
  await expect(zoomToken()).rejects.toThrow('exactly the two');
});
