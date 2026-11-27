import { IncomingCall, updateIncomingAlert } from './incoming-alerts';
import { CallLogEntry, CallQueueConfig } from './types';

interface ZoomCallPath {
  call_id: string;
  direction: string;
  caller_name?: string;
  caller_did_number?: string;
  call_path: (CallLogEntry & { is_node?: number; segment?: number })[];
}

interface ConfirmedParent {
  zoomCallId: string;
  channel: string;
  ts: string;
  route: IncomingCall['route'];
  callerNumber?: string;
}

// Use the complete Zoom call path so a late overflow event or four simultaneous
// member histories cannot change which queue the caller originally entered.
export async function applyZoomPath(token: string, parent: ConfirmedParent, history: ZoomCallPath,
  queues: ReadonlyMap<string, Pick<CallQueueConfig, 'name' | 'route_kind'>>, mondayItemId?: string,
  edit = updateIncomingAlert): Promise<void> {
  if (history.direction !== 'inbound' || history.call_id !== parent.zoomCallId) {
    throw new Error('Zoom history does not match the confirmed Slack parent');
  }
  const nodes = history.call_path.filter(leg => leg.call_id === history.call_id && leg.is_node === 1 &&
    leg.callee_ext_type === 'call_queue' && leg.callee_ext_number && leg.direction === 'inbound');
  // Zoom assigns increasing segment/node positions within a call path.
  const first = nodes.sort((a, b) => (a.segment ?? 1) - (b.segment ?? 1) ||
    (a.node ?? Infinity) - (b.node ?? Infinity))[0];
  let firstQueue: IncomingCall['firstQueue'];
  if (first?.callee_ext_number) {
    const config = queues.get(first.callee_ext_number);
    firstQueue = { name: config?.name || first.callee_name || first.callee_ext_number,
      kind: config?.route_kind || 'QUEUE' };
  }
  await edit(token, parent, { route: parent.route, callerName: history.caller_name,
    callerNumber: history.caller_did_number || parent.callerNumber, firstQueue, mondayItemId });
}
