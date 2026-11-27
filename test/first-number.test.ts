import { describe, expect, it } from 'vitest';
import { fallbackTwiml, incomingTwiml, singleQueueSettings } from '../src/twilio-entry';

const ingress = '+12025550101';
const landing = '+12025550102';
const firstPublic = '+18005550101';
const otherPublic = '+18005550102';
const menu = '+18005550103';
const advertised = { [firstPublic]: 'queue111', [otherPublic]: 'queue111', [menu]: 'receptionist' } as const;

describe('first public number rollout', () => {
  it('permits exactly one private bridge and dials the same Zoom number on fallback', () => {
    const settings = singleQueueSettings(ingress, landing, firstPublic, advertised);
    expect(Object.keys(settings.ingress)).toEqual([ingress]);
    expect(incomingTwiml(ingress, settings)).toContain('>' + landing + '</Number>');
    expect(fallbackTwiml(settings)).toBe(
      '<Response><Dial answerOnBridge="true"><Number>' + landing + '</Number></Dial></Response>'
    );
    expect(() => incomingTwiml(otherPublic, settings)).toThrow();
    const expanded = { ...settings, ingress: { ...settings.ingress, [otherPublic]: 'queue111' as const } };
    expect(() => incomingTwiml(ingress, expanded)).toThrow();
    expect(() => fallbackTwiml(expanded)).toThrow();
  });
  it.each(Object.keys(advertised))('never uses the advertised number %s as part of the private bridge', publicNumber => {
    expect(() => singleQueueSettings(publicNumber, landing, firstPublic, advertised)).toThrow();
    expect(() => singleQueueSettings(ingress, publicNumber, firstPublic, advertised)).toThrow();
  });
  it('rejects a forwarding loop, malformed destination and the main receptionist as the public target', () => {
    expect(() => singleQueueSettings(ingress, ingress, firstPublic, advertised)).toThrow();
    expect(() => singleQueueSettings(ingress, '8001', firstPublic, advertised)).toThrow();
    expect(() => singleQueueSettings(ingress, landing, menu, advertised)).toThrow();
  });
});
