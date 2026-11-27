import { classifyNotice, claimNotice, finishNotice, pendingNotices, saveNoticeReceipt } from './bridge-notices';
import { getMondayItemUrl } from './monday';
import { formatNewCallMessage, postSlackMessage } from './slack';
import { getSupabaseClient } from './supabase';
import { EntrySettings } from './twilio-entry';
import { readZoomHistory, zoomToken, ZoomCredentials } from '../scripts/link-first-number';

export async function releaseUnrelatedNotices(credentials: ZoomCredentials, settings: EntrySettings, channel: string) {
  const pending = await pendingNotices();
  const db = getSupabaseClient();
  const day = (stamp: number) => new Date(stamp).toISOString().slice(0, 10);
  const histories = new Map<string, Awaited<ReturnType<typeof readZoomHistory>>>();
  let token: string | undefined;
  for (const notice of pending) {
    const record = await db.from('rb_calls').select('monday_item_id,slack_parent_ts,caller_phone_e164,caller_name,forwarded_by_name,route_kind')
      .eq('call_id', notice.id).maybeSingle();
    if (record.error) throw Error('Cannot check deferred Zoom call');
    const row = record.data;
    if (row?.slack_parent_ts) { await finishNotice(notice.id); continue; }
    if (!row || Date.now() - notice.time < 30000) continue;
    const from = day(notice.time - 86400000);
    if (!histories.has(from)) {
      token ||= await zoomToken(credentials);
      histories.set(from, await readZoomHistory(token, from, day(Date.now())));
    }
    const disposition = classifyNotice(notice.id, histories.get(from)!, Object.values(settings.destinations));
    if (disposition !== 'legacy') {
      if (Date.now() - notice.time > 4 * 3600000) throw Error('Deferred Zoom call needs ownership review: ' + notice.id);
      continue;
    }
    let ts = notice.ts;
    if (!ts) {
      if (notice.state === 'sending') throw Error('Review uncertain Slack delivery for Zoom call ' + notice.id);
      if (!await claimNotice(notice.id)) continue;
      const text = formatNewCallMessage(row.caller_phone_e164 || 'Unknown', row.caller_name,
        row.forwarded_by_name || row.route_kind, row.route_kind, row.monday_item_id ? getMondayItemUrl(row.monday_item_id) : undefined);
      const result = await postSlackMessage(process.env.SLACK_BOT_TOKEN!, { channel, text, unfurl_links: false,
        metadata: { event_type: 'roofbuddy_zoom_call', event_payload: { zoom_call_id: notice.id } } });
      if (!result.ok || !result.ts || result.channel !== channel) throw Error('Unconfirmed deferred Slack delivery');
      ts = result.ts;
      await saveNoticeReceipt(notice.id, ts);
    }
    const bound = await db.from('rb_calls').update({ slack_parent_ts: ts }).eq('call_id', notice.id)
      .is('slack_parent_ts', null).select('slack_parent_ts').maybeSingle();
    if (bound.error || bound.data?.slack_parent_ts !== ts) throw Error('Could not bind deferred Slack alert');
    await finishNotice(notice.id);
  }
}
