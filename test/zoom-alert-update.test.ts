import { expect, it, vi } from 'vitest';
import { applyZoomPath } from '../src/zoom-alert-update';

const parent = { zoomCallId: 'zoom-1', channel: 'test', ts: '42.1', route: 'receptionist' as const };
const history = { call_id: 'zoom-1', direction: 'inbound', caller_name: 'Example', call_path: [
  { id: 'overflow', call_id: 'zoom-1', direction: 'inbound', is_node: 1, node: 3,
    callee_ext_type: 'call_queue', callee_ext_number: '8101', callee_name: 'Office Hours Overflow' },
  ...['a', 'b', 'c', 'd'].map(id => ({ id, call_id: 'zoom-1', direction: 'inbound',
    is_node: 0, node: 2, event: 'ring_to_member', callee_ext_type: 'user', callee_ext_number: id })),
  { id: 'queue', call_id: 'zoom-1', direction: 'inbound', is_node: 1, node: 2,
    callee_ext_type: 'call_queue', callee_ext_number: '8001', callee_name: '111' },
] };
const queues = new Map([['8001', { name: '111', route_kind: 'MAIN' as const }]]);

it('uses the first actual queue and sends one edit to the verified original parent', async () => {
  const edit = vi.fn();
  await applyZoomPath('token', parent, history, queues, '42', edit);
  expect(edit).toHaveBeenCalledTimes(1);
  expect(edit).toHaveBeenCalledWith('token', parent, expect.objectContaining({
    firstQueue: { name: '111', kind: 'MAIN' }, mondayItemId: '42',
  }));
});
it('keeps the menu label when the caller hangs up in the menu', async () => {
  const edit = vi.fn();
  await applyZoomPath('token', parent, { ...history, call_path: [] }, queues, undefined, edit);
  expect(edit.mock.calls[0][2].firstQueue).toBeUndefined();
});
it('does not edit another call with the same caller', async () => {
  const edit = vi.fn();
  await expect(applyZoomPath('token', parent, { ...history, call_id: 'other' }, queues, undefined, edit)).rejects.toThrow();
  expect(edit).not.toHaveBeenCalled();
});
