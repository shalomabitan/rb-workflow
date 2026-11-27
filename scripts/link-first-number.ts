// Usage: npm run link:first-number -- YYYY-MM-DD [--apply]. The date is UTC.
// Reads complete neighboring days so calls across midnight can disqualify a match.
import { linkFirstNumber, OriginalMessage, PostedAlert, QueueArrival } from '../src/first-number-link';
import { createMondayItem, MondayItemInput, MONDAY_BOARD_ID, MONDAY_COLUMNS } from '../src/monday';
import { updateSlackMessage } from '../src/slack';
import { EntrySettings, validateEntry } from '../src/twilio-entry';
import { getSupabaseClient } from '../src/supabase';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw Error('Missing ' + name);
  return value;
}

async function getJson<T>(url: URL, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(12000) });
  if (!response.ok) throw Object.assign(Error(url.hostname + ' returned ' + response.status), { status: response.status });
  return response.json() as Promise<T>;
}

interface VoiceCall {
  sid: string; parent_call_sid: string | null; from: string; to: string;
  direction: string; date_created: string; end_time: string | null;
}
const dayMs = 86400000;
const day = (t: number) => new Date(t).toISOString().slice(0, 10);

export async function readBridgeLegs(base: URL, authorization: string, landing: string, dates: string[]) {
  const calls = new Map<string, VoiceCall>();
  for (const date of dates) {
    let url = new URL(base);
    // Twilio filters StartTime by UTC date. Queued calls acquire StartTime independently
    // of DateCreated. Read adjacent days and match on the creation of the outgoing leg.
    url.search = new URLSearchParams({ To: landing, StartTime: date, PageSize: '200' }).toString();
    const seen = new Set<string>();
    for (;;) {
      if (seen.has(url.href)) throw Error('Repeated Twilio cursor');
      seen.add(url.href);
      const page = await getJson<{ calls: VoiceCall[]; next_page_uri: string | null }>(url, { headers: { authorization } });
      for (const call of page.calls) {
        if (call.to === landing) calls.set(call.sid, call);
      }
      if (page.next_page_uri === null) break;
      if (!page.next_page_uri) throw Error('Incomplete Twilio page');
      url = new URL(page.next_page_uri, base);
      if (url.origin !== base.origin || url.pathname !== base.pathname) throw Error('Unexpected Twilio page');
    }
  }
  return Array.from(calls.values(), call => ({
    parentSid: call.parent_call_sid || '', childSid: call.sid, caller: call.from, landing: call.to,
    initiated: Date.parse(call.date_created), completed: !!call.end_time, dialed: call.direction === 'outbound-dial',
  }));
}

export async function readZoomHistory(token: string, from: string, to: string): Promise<QueueArrival[]> {
  const url = new URL('https://api.zoom.us/v2/phone/call_history');
  url.search = new URLSearchParams({ from, to, page_size: '100' }).toString();
  const rows: QueueArrival[] = [];
  const seen = new Set<string>();
  for (;;) {
    const page = await getJson<{ call_history?: QueueArrival[]; call_logs?: QueueArrival[]; next_page_token: string }>(
      url, { headers: { authorization: 'Bearer ' + token } });
    const values = page.call_history ?? page.call_logs;
    if (!Array.isArray(values)) throw Error('Incomplete Zoom call history');
    rows.push(...values);
    if (page.next_page_token === '') return rows;
    if (!page.next_page_token || seen.has(page.next_page_token)) throw Error('Incomplete Zoom pagination');
    seen.add(page.next_page_token);
    url.searchParams.set('next_page_token', page.next_page_token);
  }
}

export async function forwardedTo(token: string, origin: QueueArrival, bridge: string) {
  const id = origin.call_history_uuid || origin.id;
  if (!id) return false;
  const detail = await getJson<{ call_id: string; call_elements?: QueueArrival[]; call_path?: QueueArrival[] }>(
    new URL('https://api.zoom.us/v2/phone/call_history/' + encodeURIComponent(id)),
    { headers: { authorization: 'Bearer ' + token } });
  const elements = detail.call_elements ?? detail.call_path;
  return detail.call_id === origin.call_id && !!elements?.some(row =>
    row.call_id === origin.call_id && row.callee_did_number === bridge);
}

async function itemForZoomCall(token: string, call: string): Promise<string | undefined> {
  const col = MONDAY_COLUMNS.ZOOM_CALL_ID;
  const query = 'query($b:ID!, $col:String!, $v:String!){items_page_by_column_values(board_id:$b,limit:2,' +
    'columns:[{column_id:$col,column_values:[$v]}]){cursor items{id}}}';
  const result = await getJson<{ data?: { items_page_by_column_values?: { items: { id: string }[]; cursor?: string | null } }; errors?: unknown[] }>(
    new URL('https://api.monday.com/v2'), { method: 'POST', headers: { authorization: token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { b: MONDAY_BOARD_ID, col, v: call } }) });
  const page = result.data?.items_page_by_column_values;
  if (result.errors?.length || !Array.isArray(page?.items)) throw Error('Monday lookup failed');
  if (page.cursor || page.items.length > 1) throw Error('Multiple Monday items may own this Zoom call');
  return page.items[0]?.id;
}

async function message(token: string, channel: string, ts: string): Promise<OriginalMessage | undefined> {
  const url = new URL('https://slack.com/api/conversations.history');
  url.search = new URLSearchParams({ channel, latest: ts, oldest: ts, inclusive: 'true', limit: '1',
    include_all_metadata: 'true' }).toString();
  const result = await getJson<{ ok: boolean; messages?: OriginalMessage[] }>(url, { headers: { authorization: 'Bearer ' + token } });
  if (!result.ok) throw Error('Cannot verify original Slack message');
  return result.messages?.find(m => m.ts === ts);
}

export async function zoomToken() {
  const url = new URL('https://zoom.us/oauth/token');
  let credentials: { account_id: string; client_id: string; client_secret: string };
  if (process.env.ZOOM_CREDENTIAL_PARAMETER) {
    try {
      const { stdout } = await promisify(execFile)('aws', ['ssm', 'get-parameter', '--region', 'us-west-2',
        '--with-decryption', '--name', process.env.ZOOM_CREDENTIAL_PARAMETER, '--output', 'json', '--no-cli-pager']);
      const { Parameter } = JSON.parse(stdout);
      if (Parameter.Type !== 'SecureString') throw Error();
      credentials = JSON.parse(Parameter.Value);
    } catch {
      throw Error('Could not read the encrypted Zoom credential from AWS Parameter Store');
    }
  } else {
    credentials = { account_id: required('ZOOM_ACCOUNT_ID'), client_id: required('ZOOM_CLIENT_ID'), client_secret: required('ZOOM_CLIENT_SECRET') };
  }
  if (![credentials.account_id, credentials.client_id, credentials.client_secret].every(v => typeof v === 'string' && v.length)) {
    throw Error('Incomplete Zoom credential');
  }
  const authorization = 'Basic ' + Buffer.from(credentials.client_id + ':' + credentials.client_secret).toString('base64');
  const result = await getJson<{ access_token: string; scope: string }>(url, { method: 'POST', headers: { authorization },
    body: new URLSearchParams({ grant_type: 'account_credentials', account_id: credentials.account_id }) });
  if (!result.access_token || result.scope?.trim().split(/\s+/).sort().join(' ') !==
      'phone:read:call_log:admin phone:read:list_call_logs:admin') throw Error('Zoom must grant exactly the two call-history scopes');
  return result.access_token;
}

export async function runFirstNumber(args: string[]) {
  const [target, mode, ...extra] = args;
  const start = Date.parse(target + 'T00:00:00Z');
  if (extra.length || (mode && mode !== '--apply') || !Number.isFinite(start) || day(start) !== target ||
      start > Date.now() || Date.now() - start > 6 * dayMs) throw Error('Supply a recent UTC date and optional --apply');
  const settings: EntrySettings = JSON.parse(required('ENTRY_SETTINGS'));
  validateEntry(settings);
  if (!settings.firstPublicNumber) throw Error('Requires a single private queue bridge');
  const channel = required('SLACK_CHANNEL_ID');
  const queueExt = required('FIRST_QUEUE_EXTENSION');
  const account = required('TWILIO_ACCOUNT_SID');
  const sync = required('TWILIO_SYNC_SERVICE_SID');
  if (!/^AC[0-9a-f]{32}$/i.test(account) || !/^IS[0-9a-f]{32}$/i.test(sync)) throw Error('Invalid Twilio configuration');
  const authorization = 'Basic ' + Buffer.from(required('TWILIO_API_KEY') + ':' + required('TWILIO_API_SECRET')).toString('base64');
  const headers = { authorization };
  const documents = 'https://sync.twilio.com/v1/Services/' + sync + '/Documents';
  const boardToken = required('MONDAY_API_TOKEN');
  const slackToken = required('SLACK_BOT_TOKEN');
  const dates = [day(start - dayMs), target, day(start + dayMs)].filter(date => date <= day(Date.now()));
  const legs = await readBridgeLegs(new URL('https://api.twilio.com/2010-04-01/Accounts/' + account + '/Calls.json'),
    authorization, settings.destinations.queue111!, dates);
  const candidates = legs.filter(leg => leg.dialed && leg.completed && /^CA[0-9a-f]{32}$/i.test(leg.parentSid) &&
    leg.initiated >= start && leg.initiated < start + dayMs && leg.initiated < Date.now() - 7000);
  if (!candidates.length) return {} as Record<string, number>;
  const token = await zoomToken();
  const history = await readZoomHistory(token, dates[0], dates[dates.length - 1]);
  async function claim(key: string, data: Record<string, string>) {
    try {
      await getJson(new URL(documents), { method: 'POST', headers,
        body: new URLSearchParams({ UniqueName: key, Data: JSON.stringify(data), Ttl: '604800' }) });
      return true;
    } catch (err) {
      if ((err as { status?: number }).status !== 409) throw err;
      const saved = await getJson<{ data: Record<string, string> }>(new URL(documents + '/' + key), { headers });
      if (!Object.entries(data).every(([k, v]) => saved.data[k] === v)) throw Error('Conflicting call link reservation');
      return false;
    }
  }
  async function reserve(parentSid: string, zoomId: string, slackChannel: string, ts: string, observedItem: string | undefined,
    caller: string, started: number, ended: number, status: 'ANSWERED' | 'ENDED') {
    const data = { parentSid, zoomId, channel: slackChannel, ts };
    await claim('link-parent-' + parentSid, data);
    await claim('link-zoom-' + zoomId, data);
    const db = getSupabaseClient();
    // Give Joel's existing processor its normal record. It uses these very fields
    // for subsequent status replies and the recording/analytics workflow.
    const inserted = await db.from('rb_calls').upsert({ call_id: zoomId, status,
      caller_phone_e164: caller, route_kind: 'MAIN', forwarded_by_extension_number: queueExt,
      forwarded_by_name: '111', slack_parent_ts: ts, created_at_ms: started,
      updated_at_ms: Date.now(), last_event_ts_ms: ended, last_event_rank: 50 },
      { onConflict: 'call_id', ignoreDuplicates: true });
    if (inserted.error) throw Error('Could not reserve Zoom call in the existing workflow');
    const adopt = db.from('rb_calls').update({ slack_parent_ts: ts }).eq('call_id', zoomId).is('slack_parent_ts', null);
    const adopted = await (observedItem ? adopt.or('monday_item_id.is.null,monday_item_id.eq.' + observedItem) : adopt.is('monday_item_id', null));
    if (adopted.error) throw Error('Could not attach Slack parent to Zoom call');
    const saved = await db.from('rb_calls').select('slack_parent_ts,monday_item_id').eq('call_id', zoomId).single();
    if (saved.error || saved.data.slack_parent_ts !== ts ||
        (saved.data.monday_item_id && String(saved.data.monday_item_id) !== observedItem)) {
      throw Error('Existing workflow already has a conflicting Slack parent or Monday item');
    }
  }
  async function createOnce(parentSid: string, input: MondayItemInput) {
    if (!await claim('item-create-' + input.zoomCallId, { parentSid, zoomId: input.zoomCallId })) return;
    // An interrupted request can have succeeded. Every later pass recovers by exact Zoom ID.
    return createMondayItem(boardToken, input);
  }
  async function bindItem(parentSid: string, zoomId: string, itemId: string) {
    await claim('item-link-' + zoomId, { parentSid, zoomId, itemId });
    const db = getSupabaseClient();
    const bound = await db.from('rb_calls').update({ monday_item_id: itemId })
      .eq('call_id', zoomId).is('monday_item_id', null);
    if (bound.error) throw Error('Could not attach Monday item to Zoom call');
    const saved = await db.from('rb_calls').select('monday_item_id').eq('call_id', zoomId).single();
    if (saved.error || String(saved.data.monday_item_id) !== itemId) throw Error('Existing workflow has another Monday item');
  }
  const services = { itemForZoomCall: (id: string) => itemForZoomCall(boardToken, id),
    workflowOwner: async (id: string) => {
      const r = await getSupabaseClient().from('rb_calls').select('slack_parent_ts,monday_item_id').eq('call_id', id).maybeSingle();
      if (r.error) throw Error('Could not verify existing workflow ownership');
      return r.data;
    },
    originalMessage: (ch: string, ts: string) => message(slackToken, ch, ts),
    forwardedTo: (call: QueueArrival, bridge: string) => forwardedTo(token, call, bridge),
    reserve, createOnce, bindItem, edit: (ch: string, ts: string, text: string) => updateSlackMessage(slackToken, ch, ts, text) };
  const totals: Record<string, number> = {};
  for (const leg of candidates) {
    let status: string;
    try {
      const url = new URL(documents + '/incoming-' + leg.parentSid);
      let doc: { data: PostedAlert } | undefined;
      try { doc = await getJson(url, { headers }); }
      catch (err) { if ((err as { status?: number }).status !== 404) throw err; }
      status = doc ? await linkFirstNumber(leg, legs, history, doc.data, settings, channel, queueExt, services, mode === '--apply') : 'missing-alert';
    } catch (err) {
      status = 'error';
      console.error('Call link requires review:', (err as Error).message);
    }
    totals[status] = (totals[status] || 0) + 1;
  }
  return totals;
}
if (require.main === module) runFirstNumber(process.argv.slice(2)).then(totals => {
  console.log(JSON.stringify(totals));
  if (totals.error) process.exitCode = 1;
}).catch(err => { console.error(err.message); process.exitCode = 1; });
