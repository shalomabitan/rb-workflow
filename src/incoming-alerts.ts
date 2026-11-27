import { getMondayItemUrl } from './monday';
import { formatNewCallMessage, updateSlackMessage } from './slack';

export type EntryRoute = 'queue111' | 'receptionist';
export interface IncomingCall {
  route: EntryRoute;
  callerNumber?: string;
  callerName?: string;
  mondayItemId?: string;
  // First actual queue, verified by Zoom. Overflow and later transfers belong in the thread.
  firstQueue?: { name: string; kind: string };
}

function slackText(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function incomingMessage(call: IncomingCall): string {
  const name = call.callerName ? slackText(call.callerName) : undefined;
  const phone = slackText(call.callerNumber || 'Unknown');
  const itemUrl = call.mondayItemId ? getMondayItemUrl(call.mondayItemId) : undefined;
  if (call.route === 'queue111') return formatNewCallMessage(phone, name, '111', 'MAIN', itemUrl);
  if (call.firstQueue) {
    return formatNewCallMessage(phone, name, slackText(call.firstQueue.name), slackText(call.firstQueue.kind), itemUrl);
  }
  return formatNewCallMessage(phone, name, 'Main Auto Receptionist', 'MAIN MENU', itemUrl);
}

// The caller supplies the confirmed original Slack parent for this Zoom call.
// Never select a parent using a caller's number alone.
export async function updateIncomingAlert(token: string, parent: { channel: string; ts: string },
  call: IncomingCall, edit = updateSlackMessage): Promise<void> {
  const result = await edit(token, parent.channel, parent.ts, incomingMessage(call));
  if (!result.ok) throw new Error('Slack could not update the incoming call: ' + result.error);
}
