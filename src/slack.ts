// ===================
// Slack API Client
// ===================

export interface SlackPostResult {
  ok: boolean;
  ts?: string; // Thread timestamp for replies
  error?: string;
}

export interface SlackMessagePayload {
  channel: string;
  text: string;
  thread_ts?: string; // For thread replies
  unfurl_links?: boolean;
}

export async function postSlackMessage(
  botToken: string,
  payload: SlackMessagePayload
): Promise<SlackPostResult> {
  const response = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${botToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack API error: ${response.status} ${response.statusText}`);
  }

  const result = (await response.json()) as { ok: boolean; ts?: string; error?: string };
  return {
    ok: result.ok,
    ts: result.ts,
    error: result.error,
  };
}

// ===================
// Message Formatters
// ===================

export function formatNewCallMessage(
  callerPhone: string,
  callerName: string | undefined,
  queueName: string,
  routeKind: string,
  mondayItemUrl?: string
): string {
  const caller = callerName ? `${callerName} (${callerPhone})` : callerPhone;
  const emoji = routeKind === 'MAIN' ? ':phone:' : routeKind === 'OVERFLOW' ? ':warning:' : ':telephone_receiver:';
  let message = `${emoji} *Incoming Call*\n` +
    `> *From:* ${caller}\n` +
    `> *Queue:* ${queueName} (${routeKind})`;

  if (mondayItemUrl) {
    message += `\n> *Action:* <${mondayItemUrl}|Open in Monday>`;
  }

  return message;
}

export function formatStatusUpdateMessage(
  previousStatus: string | undefined,
  newStatus: string,
  details?: {
    answeredBy?: string;
    duration?: number;
    routeKind?: string;
    queueName?: string;
  }
): string {
  const statusEmoji: Record<string, string> = {
    RINGING: ':bell:',
    ANSWERED: ':white_check_mark:',
    MISSED: ':x:',
    ENDED: ':telephone_receiver:',
  };

  const emoji = statusEmoji[newStatus] || ':information_source:';
  let message = `${emoji} Status: *${previousStatus || 'NEW'}* → *${newStatus}*`;

  if (newStatus === 'ANSWERED' && details?.answeredBy) {
    message += `\n> Answered by: ${details.answeredBy}`;
  }

  if (newStatus === 'ENDED' && details?.duration !== undefined) {
    const mins = Math.floor(details.duration / 60);
    const secs = details.duration % 60;
    message += `\n> Duration: ${mins}m ${secs}s`;
  }

  if (details?.routeKind && details.routeKind !== 'MAIN') {
    message += `\n> Route: ${details.queueName || details.routeKind}`;
  }

  return message;
}
