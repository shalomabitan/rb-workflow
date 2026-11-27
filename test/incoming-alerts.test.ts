import { describe, expect, it, vi } from 'vitest';
import { incomingMessage, updateIncomingAlert } from '../src/incoming-alerts';
import { formatNewCallMessage } from '../src/slack';
import { getMondayItemUrl } from '../src/monday';
import { incomingTwiml, validateEntry } from '../src/twilio-entry';
import { deliverProgress } from '../src/twilio-progress';

const queueNumber = '+18005550101';
const mainNumber = '+18005550102';
const queueLanding = '+12125550101';
const menuLanding = '+12125550102';
const advertisedRoutes = {
  [queueNumber]: 'queue111', [mainNumber]: 'receptionist',
} as const;
const settings = { advertised: advertisedRoutes, ingress: advertisedRoutes, destinations: { queue111: queueLanding, receptionist: menuLanding } };
const number = '+12125550103';
const parent = 'CA' + 'a'.repeat(32);
const child = 'CA' + 'c'.repeat(32);

describe('Twilio entry routing', () => {
  it.each(Object.entries(advertisedRoutes))('%s preserves its Zoom destination', (entry, route) => {
    const xml = incomingTwiml(entry, settings);
    expect(xml.startsWith('<Response><Dial answerOnBridge="true">')).toBe(true);
    expect(xml).toContain('>' + settings.destinations[route] + '</Number>');
    expect(xml).toContain('statusCallback="/incoming-progress?route=' + route + '"');
    expect(xml).not.toMatch(/callerId|Gather|Say|timeLimit/);
  });

  it('fails on a forwarding loop, a swapped public number or an unknown ingress', () => {
    expect(() => validateEntry({ ...settings, destinations: { ...settings.destinations, queue111: mainNumber } })).toThrow();
    expect(() => validateEntry({ advertised: advertisedRoutes, ingress: { [queueNumber]: 'receptionist' }, destinations: settings.destinations })).toThrow();
    expect(() => validateEntry({ advertised: advertisedRoutes, ingress: { [queueNumber]: 'queue111' }, destinations: { queue111: mainNumber } })).toThrow();
    expect(() => validateEntry({ ...settings, destinations: { queue111: queueLanding, receptionist: queueLanding } })).toThrow();
    expect(() => incomingTwiml('+12125550199', settings)).toThrow();
  });
});

describe('existing Slack layout', () => {
  it('matches the established queue 111 text byte-for-byte including the board link', () => {
    const caller = { route: 'queue111' as const, callerName: 'Example', callerNumber: number, mondayItemId: '42' };
    expect(incomingMessage(caller)).toBe(formatNewCallMessage(number, 'Example', '111', 'MAIN', getMondayItemUrl('42')));
    expect(incomingMessage({ ...caller, firstQueue: { name: 'Office Hours Overflow', kind: 'OVERFLOW' } })).toBe(incomingMessage(caller));
  });

  it('names the receptionist until a queue is known and edits the same parent with the selected queue and board link', async () => {
    expect(incomingMessage({ route: 'receptionist', callerNumber: number })).toBe(
      ':phone: *Incoming Call*\n> *From:* ' + number + '\n> *Queue:* Main Auto Receptionist (MAIN MENU)');
    const edit = vi.fn().mockResolvedValue({ ok: true, ts: '42.1' });
    await updateIncomingAlert('test-token', { channel: 'channel', ts: '42.1' }, {
      route: 'receptionist', callerNumber: number, firstQueue: { name: '111', kind: 'MAIN' }, mondayItemId: '42',
    }, edit);
    expect(edit).toHaveBeenCalledTimes(1);
    expect(edit).toHaveBeenCalledWith('test-token', 'channel', '42.1',
      formatNewCallMessage(number, undefined, '111', 'MAIN', getMondayItemUrl('42')));
  });

  it('retains private caller labels and escapes caller-provided Slack markup', () => {
    expect(incomingMessage({ route: 'queue111', callerNumber: 'anonymous' })).toContain('*From:* anonymous');
    expect(incomingMessage({ route: 'queue111', callerName: '<!channel>' })).toContain('&lt;!channel&gt;');
  });
});

function harness() {
  const rows = new Map<string, { state: 'posting' | 'posted'; route: 'queue111'; channel: string; ts?: string }>();
  type Row = NonNullable<ReturnType<typeof rows.get>>;
  const documents = Object.assign((key: string) => ({
      fetch: async () => ({ data: rows.get(key)! }),
      update: async ({ data }: { data: Row }) => { rows.set(key, data); },
      remove: async () => rows.delete(key),
    }), { create: async ({ uniqueName, data }: { uniqueName: string; data: Row }) => {
      if (rows.has(uniqueName)) throw { status: 409 };
      rows.set(uniqueName, data);
    } });
  const context = {
    ACCOUNT_SID: 'AC-test', ENTRY_SETTINGS: JSON.stringify(settings), SYNC_SERVICE_SID: 'IS-test',
    SLACK_BOT_TOKEN: 'test-token', SLACK_CHANNEL_ID: 'test-channel',
    getTwilioClient: () => ({
      calls: () => ({ fetch: async () => ({ direction: 'inbound', from: number, to: queueNumber }) }),
      sync: { v1: { services: () => ({ documents }) } },
    }),
  } as unknown as Parameters<typeof deliverProgress>[0];
  const event = { AccountSid: 'AC-test', ParentCallSid: parent, CallSid: child, To: queueLanding,
    route: 'queue111' as const, CallStatus: 'initiated', Timestamp: new Date().toUTCString() };
  return { context, event, rows };
}

describe('one Twilio parent per original call', () => {
  it('handles concurrent callbacks, redelivery and a separate call from the same caller', async () => {
    const { context, event } = harness();
    const post = vi.fn().mockResolvedValue({ ok: true, ts: '42.1' });
    await Promise.allSettled([deliverProgress(context, event, post), deliverProgress(context, { ...event, CallSid: 'CA'+'e'.repeat(32) }, post)]);
    await deliverProgress(context, event, post);
    expect(post).toHaveBeenCalledTimes(1);
    await deliverProgress(context, { ...event, ParentCallSid: 'CA'+'b'.repeat(32) }, post);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('retains an uncertain delivery and can retry a definite pre-send rejection', async () => {
    const { context, event } = harness();
    const post = vi.fn().mockResolvedValueOnce({ ok: false, error: 'not_in_channel' }).mockRejectedValueOnce(new Error('timeout'));
    await expect(deliverProgress(context, event, post)).rejects.toThrow('not_in_channel');
    await expect(deliverProgress(context, event, post)).rejects.toThrow('timeout');
    await expect(deliverProgress(context, event, post)).rejects.toThrow('reconcile');
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('rejects unrelated, late and mismatched callbacks without posting', async () => {
    const { context, event } = harness();
    const post = vi.fn();
    for (const change of [{ To: menuLanding }, { AccountSid: 'other' }, { CallStatus: 'completed' }, { Timestamp: '2000-01-01' },
        { route: 'receptionist' as const, To: menuLanding }]) {
      await expect(deliverProgress(context, { ...event, ...change }, post)).rejects.toThrow();
    }
    expect(post).not.toHaveBeenCalled();
  });
});
