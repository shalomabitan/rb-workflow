import { describe, it, expect } from 'vitest';
import { classifyNotice } from '../src/bridge-notices';
const landing = '+12125550101';
const line = '+12125550102';
const inbound = { call_id: '111', direction: 'inbound', callee_did_number: landing, end_time: '2026-01-01T12:00:20Z' };
describe('Zoom member calls associated with a possible early notice', () => {
  it('identifies a private arrival by Zoom call ID even when the member event only names their direct phone', () => {
    expect(classifyNotice('111', [inbound, { ...inbound, callee_did_number: line }], [landing])).toBe('bridge');
  });
  it('releases an unrelated call from the same caller only after its own incoming destination is available', () => {
    const unrelated = { ...inbound, call_id: '222', callee_did_number: line };
    expect(classifyNotice('222', [inbound, unrelated], [landing])).toBe('legacy');
    expect(classifyNotice('222', [inbound, { ...unrelated, end_time: '' }], [landing])).toBe('unknown');
    expect(classifyNotice('222', [inbound, { ...unrelated, direction: 'outbound' }], [landing])).toBe('unknown');
  });
});
