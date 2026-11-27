import { createHash } from 'node:crypto';
import type { QueryCommandOutput } from '@aws-sdk/client-dynamodb';
import { DeleteItemCommand, DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import type { QueueArrival } from './first-number-link';
import type { NormalizedEvent } from './types';

const db = new DynamoDBClient({ maxAttempts: 2 });
const table = () => process.env.BRIDGE_NOTICE_TABLE;
const days = (n: number) => Math.floor(Date.now() / 1000) + n * 86400;
const fourHours = 4 * 3600_000;
const pendingKey = (id: string) => ({ pk: { S: 'pending' }, sk: { S: id } });
const callerKey = (phone?: string) => phone && /^\+[1-9]\d{7,14}$/.test(phone)
  ? 'caller/' + createHash('sha256').update(phone).digest('hex') : undefined;

export async function rememberBridge(phone: string, sid: string, started: number) {
  const key = callerKey(phone);
  if (!key || !table() || !/^CA[0-9a-f]{32}$/i.test(sid)) return;
  await db.send(new UpdateItemCommand({ TableName: table(), Key: { pk: { S: key }, sk: { S: sid } },
    UpdateExpression: 'SET started = if_not_exists(started, :s), expires = :e',
    ExpressionAttributeValues: { ':s': { N: String(started) }, ':e': { N: String(days(1)) } } }));
}

export async function endBridge(phone: string, sid: string, ended: number) {
  const key = callerKey(phone);
  if (!key || !table() || !/^CA[0-9a-f]{32}$/i.test(sid) || !Number.isFinite(ended)) return;
  try {
    await db.send(new UpdateItemCommand({ TableName: table(), Key: { pk: { S: key }, sk: { S: sid } },
      ConditionExpression: 'attribute_exists(pk)', UpdateExpression: 'SET ended = :e',
      ExpressionAttributeValues: { ':e': { N: String(ended) } } }));
  } catch (e) { if ((e as Error).name !== 'ConditionalCheckFailedException') throw e; }
}

export async function mightBeBridged(event: NormalizedEvent) {
  const key = callerKey(event.caller_phone_e164);
  if (!key || !table()) return false;
  const time = event.ringing_start_time_ms || event.event_ts_ms;
  let cursor;
  do {
    const page: QueryCommandOutput = await db.send(new QueryCommand({ TableName: table(), ConsistentRead: true,
      KeyConditionExpression: 'pk = :k', FilterExpression: '(started BETWEEN :lo AND :hi) AND (attribute_not_exists(ended) OR ended >= :ring)', Select: 'COUNT',
      ExclusiveStartKey: cursor, ExpressionAttributeValues: { ':k': { S: key },
        ':ring': { N: String(time - 3000) }, ':lo': { N: String(time - fourHours) }, ':hi': { N: String(time + 2000) } } }));
    if (page.Count) return true;
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return false;
}

export interface PendingNotice { id: string; time: number; state?: string; ts?: string }

export async function deferNotice(event: NormalizedEvent) {
  try {
    await db.send(new PutItemCommand({ TableName: table(), ConditionExpression: 'attribute_not_exists(pk)',
      Item: { ...pendingKey(event.call_id), started: { N: String(event.event_ts_ms) },
        expires: { N: String(days(7)) } } }));
  } catch (e) { if ((e as Error).name !== 'ConditionalCheckFailedException') throw e; }
}

export async function pendingNotices(): Promise<PendingNotice[]> {
  const rows: PendingNotice[] = [];
  if (!table()) return rows;
  let cursor;
  do {
    const page: QueryCommandOutput = await db.send(new QueryCommand({ TableName: table(), ConsistentRead: true, ExclusiveStartKey: cursor,
      KeyConditionExpression: 'pk = :k', ExpressionAttributeValues: { ':k': { S: 'pending' } } }));
    for (const i of page.Items || []) rows.push({ id: i.sk.S!, time: Number(i.started.N), state: i.delivery?.S, ts: i.ts?.S });
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return rows;
}

export function finishNotice(id: string) {
  return db.send(new DeleteItemCommand({ TableName: table(), Key: pendingKey(id) }));
}
export async function claimNotice(id: string) {
  try {
    await db.send(new UpdateItemCommand({ TableName: table(), Key: pendingKey(id),
      ConditionExpression: 'attribute_exists(pk) AND attribute_not_exists(delivery)', UpdateExpression: 'SET delivery = :s',
      ExpressionAttributeValues: { ':s': { S: 'sending' } } }));
    return true;
  } catch (e) { if ((e as Error).name === 'ConditionalCheckFailedException') return false; throw e; }
}
export function saveNoticeReceipt(id: string, ts: string) {
  return db.send(new UpdateItemCommand({ TableName: table(), Key: pendingKey(id), ConditionExpression: 'delivery = :s',
    UpdateExpression: 'SET delivery = :p, ts = :t', ExpressionAttributeValues: {
      ':s': { S: 'sending' }, ':p': { S: 'posted' }, ':t': { S: ts } } }));
}

// A matching caller opens a short review; only the exact Zoom call ID and
// the incoming public/private DID determine which workflow owns the message.
export function classifyNotice(id: string, history: QueueArrival[], landings: string[]) {
  const calls = history.filter(row => row.call_id === id && row.direction === 'inbound' && row.callee_did_number);
  if (calls.some(row => landings.includes(row.callee_did_number!))) return 'bridge';
  if (calls.length && calls.every(row => row.end_time) &&
      new Set(calls.map(row => row.callee_did_number)).size === 1) return 'legacy';
  return 'unknown';
}
