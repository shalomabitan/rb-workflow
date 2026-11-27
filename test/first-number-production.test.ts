import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { expect, it } from 'vitest';
import twilio from 'twilio';
import { signedForm, voice } from '../src/first-number-production';

const auth = { account: 'AC' + 'a'.repeat(32), token: 'test-token' };
function callback(): APIGatewayProxyEventV2 {
  const host = 'voice.example.test';
  const path = '/incoming-progress';
  const query = 'route=queue111';
  const values = { AccountSid: auth.account, CallStatus: 'initiated', FutureField: '+1 example' };
  const sig = twilio.getExpectedTwilioSignature(auth.token, 'https://' + host + path + '?' + query, values);
  return { requestContext: { domainName: host, http: { method: 'POST' } }, rawPath: path, rawQueryString: query,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': sig },
    body: Buffer.from(new URLSearchParams(values).toString()).toString('base64'), isBase64Encoded: true
  } as APIGatewayProxyEventV2;
}
it('verifies the signed query and all form fields including future provider fields', () => {
  const event = callback();
  expect(signedForm(event, auth)?.get('FutureField')).toBe('+1 example');
  expect(signedForm({ ...event, rawQueryString: 'route=elsewhere' }, auth)).toBeUndefined();
  expect(signedForm({ ...event, body: Buffer.from('AccountSid=' + auth.account).toString('base64') }, auth)).toBeUndefined();
  expect(signedForm(event, { ...auth, account: 'different' })).toBeUndefined();
});
it('rejects an unsigned request before loading credentials', async () => {
  const event = callback();
  delete event.headers['x-twilio-signature'];
  expect(await voice(event)).toEqual({ statusCode: 403 });
});
