# Webhook Proxy Design

## Overview

A new Lambda endpoint that acts as a pass-through proxy. Incoming requests are looked up in `rb_webhook_proxies` by `source` + `webhook_id`, then forwarded to the configured `url`. The downstream response is returned to the caller.

**Endpoint:** `POST /proxy/{source}/{webhookId}`

**Flow:**
```
Caller → API Gateway → proxy Lambda → lookup DB → forward to url → return response
```

## Database Schema

**Table: `rb_webhook_proxies`**

```sql
CREATE TABLE rb_webhook_proxies (
  source TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  url TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (source, webhook_id)
);

-- Index for lookups
CREATE INDEX idx_webhook_proxies_enabled
  ON rb_webhook_proxies (source, webhook_id)
  WHERE enabled = true;
```

## Lambda Implementation

**File:** `src/proxy.ts`

**Behavior:**
1. Extract `source` and `webhookId` from path parameters
2. Query `rb_webhook_proxies` for matching enabled record
3. If not found → return `404`
4. Forward request body to `url` (preserve content-type)
5. Log to CloudWatch: source, webhookId, request body, response status, response body, duration
6. Return downstream status code and body to caller

**Error handling:**
- DB lookup fails → `500` with error logged
- Downstream request fails (network error) → `502 Bad Gateway`
- Downstream timeout → `504 Gateway Timeout`

**Timeout:** 30 seconds

## Serverless Configuration

**Addition to `serverless.yml`:**

```yaml
functions:
  proxy:
    handler: src/proxy.handler
    timeout: 30
    memorySize: 128
    events:
      - httpApi:
          method: POST
          path: /proxy/{source}/{webhookId}
```

## Files to Create/Modify

1. `src/proxy.ts` - New Lambda handler
2. `serverless.yml` - Add proxy function
3. Migration for `rb_webhook_proxies` table (via Supabase)
