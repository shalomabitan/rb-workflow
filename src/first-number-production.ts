import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { GetParametersCommand, SSMClient } from '@aws-sdk/client-ssm';
import twilio from 'twilio';
import { EntryRoute } from './incoming-alerts';
import { EntrySettings, incomingTwiml, publicNumbersFor, validateEntry } from './twilio-entry';
import { deliverProgress } from './twilio-progress';
import { runFirstNumber, ZoomCredentials } from '../scripts/link-first-number';

interface Route { account: string; sync: string; queueExt: string; menuExt?: string; channel: string; settings: EntrySettings }
interface Auth { account: string; token: string }
interface Configuration { route: Route; auth: Auth; zoom?: ZoomCredentials }

const prefix = '/zoom-workflow/first-number/';
const ssm = new SSMClient({});
let cached: { value: Configuration; until: number } | undefined;

async function configuration(worker: boolean): Promise<Configuration> {
  if (process.env.FIRST_NUMBER_STAGE !== 'prod') throw Error('Inactive voice route');
  if (cached && cached.until > Date.now() && (!worker || cached.value.zoom)) return cached.value;
  const keys = ['route', 'twilio-account'];
  if (worker) keys.push('zoom-call-history');
  const result = await ssm.send(new GetParametersCommand({ Names: keys.map(k => prefix + k), WithDecryption: true }));
  function value<T>(key: string): T {
    const p = result.Parameters?.find(p => p.Name === prefix + key);
    if (p?.Type !== 'SecureString' || !p.Value) throw Error('Missing encrypted voice configuration');
    return JSON.parse(p.Value);
  }
  const auth = value<Auth>('twilio-account');
  const route = value<Route>('route');
  validateEntry(route.settings);
  if (!route.settings.firstPublicNumber || route.account !== auth.account || !auth.token ||
      !/^AC[0-9a-f]{32}$/i.test(auth.account) || !/^IS[0-9a-f]{32}$/i.test(route.sync) ||
      route.channel !== process.env.SLACK_CHANNEL_ID || !route.queueExt) throw Error('Invalid voice configuration');
  if (publicNumbersFor(route.settings, 'receptionist').length && !route.menuExt) throw Error('Missing menu extension');
  const config = { auth, route, zoom: worker ? value<ZoomCredentials>('zoom-call-history') : undefined };
  cached = { value: config, until: Date.now() + 300_000 };
  return config;
}

function progressContext({ auth, route }: Configuration) {
  const client = twilio(auth.account, auth.token, { timeout: 5000 });
  return { ACCOUNT_SID: auth.account, ENTRY_SETTINGS: JSON.stringify(route.settings), SYNC_SERVICE_SID: route.sync,
    SLACK_CHANNEL_ID: route.channel, SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN!, getTwilioClient: () => client };
}

// Verify the exact public URL and every form field before interpreting the callback.
export function signedForm(event: APIGatewayProxyEventV2, auth: Auth): URLSearchParams | undefined {
  if (event.requestContext.http.method !== 'POST' ||
      !event.headers['content-type']?.toLowerCase().startsWith('application/x-www-form-urlencoded')) return;
  const signature = event.headers['x-twilio-signature'];
  if (!signature) return;
  const body = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : event.body;
  const form = new URLSearchParams(body);
  const fields: Record<string, string | string[]> = Object.create(null);
  for (const key of new Set(form.keys())) {
    const values = form.getAll(key);
    fields[key] = values.length === 1 ? values[0] : values;
  }
  const url = 'https://' + event.requestContext.domainName + event.rawPath +
    (event.rawQueryString ? '?' + event.rawQueryString : '');
  if (twilio.validateRequest(auth.token, signature, url, fields) && form.get('AccountSid') === auth.account) return form;
}

export async function voice(event: APIGatewayProxyEventV2) {
  if (!event.headers['x-twilio-signature']) return { statusCode: 403 };
  const config = await configuration(false);
  const form = signedForm(event, config.auth);
  if (!form) return { statusCode: 403 };
  const field = (key: string) => form.get(key) || '';
  if (event.rawPath === '/incoming') {
    if (field('Direction') !== 'inbound' || !Object.hasOwn(config.route.settings.ingress, field('To'))) return { statusCode: 400 };
    return { statusCode: 200, headers: { 'content-type': 'application/xml' },
      body: incomingTwiml(field('To'), config.route.settings) };
  }
  const route = event.queryStringParameters?.route;
  if (event.rawPath !== '/incoming-progress' || (route !== 'queue111' && route !== 'receptionist') ||
      !publicNumbersFor(config.route.settings, route).length) return { statusCode: 400 };
  await deliverProgress(progressContext(config), { route, AccountSid: field('AccountSid'),
    CallSid: field('CallSid'), ParentCallSid: field('ParentCallSid'), CallStatus: field('CallStatus'),
    Timestamp: field('Timestamp'), To: field('To') });
  return { statusCode: 204 };
}

export async function link() {
  const config = await configuration(true);
  const { auth, route } = config;
  Object.assign(process.env, { ENTRY_SETTINGS: JSON.stringify(route.settings), FIRST_QUEUE_EXTENSION: route.queueExt,
    TWILIO_ACCOUNT_SID: auth.account, TWILIO_API_KEY: auth.account, TWILIO_API_SECRET: auth.token,
    TWILIO_SYNC_SERVICE_SID: route.sync, MENU_EXTENSION: route.menuExt || '' });
  const now = new Date();
  // Revisit yesterday after midnight and once an hour for delayed call histories.
  const dates = [now];
  if (now.getUTCHours() === 0 || now.getUTCMinutes() < 4) dates.push(new Date(now.getTime() - 86_400_000));
  let failed = false;
  for (const date of dates) {
    const day = date.toISOString().slice(0, 10);
    const activeRoutes = new Set<EntryRoute>(Object.values(route.settings.ingress));
    for (const entry of activeRoutes) {
      const counts = await runFirstNumber([day, '--apply'], undefined, { route: entry, zoom: config.zoom, skipCompleted: true,
        recoverAlert: leg => deliverProgress(progressContext(config), { route: entry, AccountSid: auth.account,
          ParentCallSid: leg.parentSid, CallSid: leg.childSid, To: leg.landing, CallStatus: 'initiated',
          Timestamp: new Date(leg.initiated).toISOString() }) });
      console.log(JSON.stringify({ metric: 'first_number_links', day, route: entry, counts }));
      if (counts.error || counts['workflow-conflict'] || counts['unverified-message']) failed = true;
    }
  }
  if (failed) throw Error('Review first-number link outcomes');
}
