import { SQSEvent } from 'aws-lambda';
import { loadConfig } from './types';
import { postSlackMessage } from './slack';

const config = loadConfig();

export async function handler(sqsEvent: SQSEvent): Promise<void> {
  console.log('=== DLQ ALERT START ===');

  for (const record of sqsEvent.Records) {
    try {
      const body = JSON.parse(record.body);
      const callId = body.call_id || 'unknown';
      const eventType = body.event_type || 'unknown';
      const receiveCount = record.attributes?.ApproximateReceiveCount || '?';

      const message = [
        ':warning: *Event moved to DLQ after repeated failures*',
        '',
        `*Call ID:* \`${callId}\``,
        `*Event Type:* ${eventType}`,
        `*Receive Count:* ${receiveCount}`,
        `*Message ID:* ${record.messageId}`,
        '',
        '```',
        JSON.stringify(body, null, 2).slice(0, 500),
        '```',
      ].join('\n');

      await postSlackMessage(config.slackBotToken, {
        channel: config.slackChannelId,
        text: message,
        unfurl_links: false,
      });

      console.log(`Slack alert sent for DLQ message: ${record.messageId}`);
    } catch (error) {
      console.error('Failed to send DLQ alert:', error);
    }
  }
}
