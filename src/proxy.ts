import { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { getSupabaseClient, SupabaseClientType } from './supabase';

// ===================
// Types
// ===================

interface WebhookProxy {
  source: string;
  webhook_id: string;
  url: string;
  enabled: boolean;
}

// ===================
// Dependencies for Testing
// ===================

export interface ProxyDependencies {
  supabase: SupabaseClientType;
}

// ===================
// Create Handler with Dependencies
// ===================

export function createProxyHandler(deps: ProxyDependencies) {
  const { supabase } = deps;

  return async function handler(
    event: APIGatewayProxyEventV2
  ): Promise<APIGatewayProxyResultV2> {
    const startTime = Date.now();
    const source = event.pathParameters?.source;
    const webhookId = event.pathParameters?.webhookId;

    console.log('=== PROXY START ===');
    console.log('Source:', source);
    console.log('Webhook ID:', webhookId);

    // Validate path parameters
    if (!source || !webhookId) {
      console.error('Missing path parameters');
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing source or webhookId' }),
      };
    }

    try {
      // Look up the webhook proxy configuration
      const { data: proxy, error: dbError } = await supabase
        .from('rb_webhook_proxies')
        .select('*')
        .eq('source', source)
        .eq('webhook_id', webhookId)
        .eq('enabled', true)
        .single<WebhookProxy>();

      if (dbError) {
        // PGRST116 = no rows found
        if (dbError.code === 'PGRST116') {
          console.log('Proxy not found or disabled:', { source, webhookId });
          return {
            statusCode: 404,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Webhook proxy not found' }),
          };
        }
        console.error('Database error:', dbError);
        return {
          statusCode: 500,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Database error' }),
        };
      }

      console.log('Proxy found, forwarding to:', proxy.url);
      console.log('Request body:', event.body);
      console.log('Request headers:', JSON.stringify(event.headers));

      // Forward the request to the configured URL
      const contentType = event.headers['content-type'] || 'application/json';

      let response: Response;
      try {
        response = await fetch(proxy.url, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
          },
          body: event.body || '',
          signal: AbortSignal.timeout(25000), // 25s timeout (leave buffer for Lambda)
        });
      } catch (fetchError) {
        const duration = Date.now() - startTime;
        console.error('Fetch error:', fetchError);
        console.log('Duration (ms):', duration);

        // Check if it's a timeout
        if (fetchError instanceof Error && fetchError.name === 'TimeoutError') {
          return {
            statusCode: 504,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ error: 'Gateway timeout' }),
          };
        }

        return {
          statusCode: 502,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ error: 'Bad gateway' }),
        };
      }

      const responseBody = await response.text();
      const duration = Date.now() - startTime;

      console.log('Response status:', response.status);
      console.log('Response body:', responseBody);
      console.log('Duration (ms):', duration);
      console.log('=== PROXY END ===');

      // Return downstream response to caller
      return {
        statusCode: response.status,
        headers: { 'Content-Type': response.headers.get('content-type') || 'application/json' },
        body: responseBody,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      console.error('Unexpected error:', error);
      console.log('Duration (ms):', duration);

      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Internal server error' }),
      };
    }
  };
}

// ===================
// Default Handler (Lambda Entry Point)
// ===================

const supabase = getSupabaseClient();

export const handler = createProxyHandler({
  supabase,
});
