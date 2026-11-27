import { EntryRoute } from './incoming-alerts';

type RoutingTable = Readonly<Record<string, EntryRoute>>;
export interface EntrySettings {
  ingress: RoutingTable;
  destinations: Partial<Record<EntryRoute, string>>;
  advertised: RoutingTable;
  firstPublicNumber?: string;
  publicNumbers?: Partial<Record<EntryRoute, string[]>>;
}

const phone = /^\+[1-9]\d{7,14}$/;
const routes: EntryRoute[] = ['queue111', 'receptionist'];

// Only routes explicitly enabled in this installation can receive calls.
// Landing numbers must be outside the set being forwarded by Twilio.
export function validateEntry(settings: EntrySettings): void {
  const active = Object.entries(settings.ingress);
  if (!active.length) throw new Error('No Twilio entry numbers configured');
  if (settings.publicNumbers) {
    const owned = new Set<string>();
    for (const [route, numbers] of Object.entries(settings.publicNumbers)) {
      if (!routes.includes(route as EntryRoute) || !Array.isArray(numbers) || !numbers.length ||
          active.filter(([, configured]) => configured === route).length !== 1) throw Error('Missing dedicated voice route');
      for (const number of numbers) {
        if (!phone.test(number) || owned.has(number) || settings.advertised[number] !== route) throw Error('Invalid public number assignment');
        owned.add(number);
      }
    }
    if (settings.firstPublicNumber && !settings.publicNumbers.queue111?.includes(settings.firstPublicNumber)) {
      throw Error('Existing public number missing from queue route');
    }
    if (active.some(([entry, route]) => !settings.publicNumbers?.[route]?.length ||
        Object.hasOwn(settings.advertised, entry) || Object.hasOwn(settings.advertised, settings.destinations[route] || ''))) {
      throw Error('Public numbers cannot be private bridges or destinations');
    }
  } else if (settings.firstPublicNumber) {
    const original = settings.firstPublicNumber;
    const [bridge] = active;
    if (!phone.test(original) || settings.advertised[original] !== 'queue111' ||
        active.length !== 1 || bridge[1] !== 'queue111' ||
        Object.hasOwn(settings.advertised, bridge[0]) ||
        Object.hasOwn(settings.advertised, settings.destinations.queue111 || '')) {
      throw new Error('First-number rollout requires a single private queue bridge');
    }
  }
  const used = new Set<EntryRoute>();
  for (const [entry, route] of active) {
    if (!phone.test(entry) || !routes.includes(route)) throw new Error('Invalid entry route');
    const advertised = settings.advertised[entry];
    if (advertised && route !== advertised) throw new Error('Advertised number mapped to the wrong Zoom destination');
    const destination = settings.destinations[route];
    if (!destination || !phone.test(destination)) throw new Error('Zoom landing number required');
    if (Object.hasOwn(settings.ingress, destination)) throw new Error('Forwarding loop');
    const destinationOwner = settings.advertised[destination];
    if (destinationOwner && destinationOwner !== route) throw new Error('Landing number belongs to a different Zoom route');
    used.add(route);
  }
  if (used.size > 1 && settings.destinations.queue111 === settings.destinations.receptionist) {
    throw new Error('The queue and the main menu need distinct landing numbers');
  }
}

export function publicNumbersFor(settings: EntrySettings, route: EntryRoute): string[] {
  return settings.publicNumbers?.[route] ?? (route === 'queue111' && settings.firstPublicNumber ? [settings.firstPublicNumber] : []);
}

// For the first public cutover, neither end of the private bridge can be
// one of the seven queue numbers or the separately advertised 877 menu.
export function singleQueueSettings(twilioNumber: string, zoomLandingNumber: string, original: string,
  advertised: RoutingTable): EntrySettings {
  const settings: EntrySettings = {
    ingress: { [twilioNumber]: 'queue111' },
    destinations: { queue111: zoomLandingNumber },
    firstPublicNumber: original,
    advertised,
  };
  validateEntry(settings);
  return settings;
}

export function fallbackTwiml(settings: EntrySettings): string {
  validateEntry(settings);
  const entries = Object.keys(settings.ingress);
  if (entries.length !== 1 || settings.ingress[entries[0]] !== 'queue111' ||
      Object.hasOwn(settings.advertised, settings.destinations.queue111!)) {
    throw new Error('The fallback requires one private queue bridge');
  }
  return '<Response><Dial answerOnBridge="true"><Number>' +
    settings.destinations.queue111 + '</Number></Dial></Response>';
}

// Register as a Protected Twilio Function. Twilio validates the request signature.
// The dialing path does no database or Slack I/O. Twilio sends progress separately.
export function incomingTwiml(to: string, settings: EntrySettings): string {
  validateEntry(settings);
  if (!Object.hasOwn(settings.ingress, to)) throw new Error('Unconfigured entry number');
  const route = settings.ingress[to];
  const destination = settings.destinations[route];
  return '<Response><Dial answerOnBridge="true"><Number statusCallback="/incoming-progress?route=' +
    route + '" statusCallbackEvent="initiated" statusCallbackMethod="POST">' +
    destination + '</Number></Dial></Response>';
}

interface VoiceContext {
  ACCOUNT_SID: string;
  ENTRY_SETTINGS: string;
}
interface VoiceEvent {
  AccountSid: string;
  Direction: string;
  To: string;
}
interface TwilioResponse {
  appendHeader(name: string, value: string): void;
  setBody(xml: string): void;
}
declare const Twilio: { Response: new () => TwilioResponse };
export function handler(context: VoiceContext, event: VoiceEvent, callback: (error: Error | null, response?: TwilioResponse) => void): void {
  try {
    if (event.AccountSid !== context.ACCOUNT_SID || event.Direction !== 'inbound') {
      throw new Error('Unexpected inbound request');
    }
    const response = new Twilio.Response();
    response.appendHeader('Content-Type', 'text/xml; charset=utf-8');
    response.setBody(incomingTwiml(event.To, JSON.parse(context.ENTRY_SETTINGS) as EntrySettings));
    callback(null, response);
  } catch (err) {
    // Configure a separate Twilio fallback URL for each entry destination.
    callback(err instanceof Error ? err : new Error('Invalid voice configuration'));
  }
}
