# Call Analytics Design

## Overview

Ingest `phone.callee_call_history_completed` events, store raw data, recompute aggregates on every event, and queue one-time enrichments (AI, external APIs) separately.

**Principle:** Hot path stays fast. Recomputable fields update every event. One-time enrichments run async via a trigger queue.

## Tables

### `rb_call_events` (raw time series)

Stores every incoming event for audit/replay.

```sql
CREATE TABLE rb_call_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  event_ts BIGINT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_events_call_id ON rb_call_events (call_id);
CREATE INDEX idx_call_events_created_at ON rb_call_events (created_at);

ALTER TABLE rb_call_events ENABLE ROW LEVEL SECURITY;
```

### `rb_call_logs` (extracted log entries)

Individual call leg records, upserted from `call_logs` array.

```sql
CREATE TABLE rb_call_logs (
  id TEXT PRIMARY KEY,  -- Zoom's log id
  call_id TEXT NOT NULL,
  call_path_id TEXT,
  direction TEXT,
  result TEXT,  -- no_answer, ring_timeout, abandoned, answered, voicemail, etc.
  node INTEGER,

  -- Caller
  caller_name TEXT,
  caller_phone_e164 TEXT,

  -- Callee (who was rung)
  callee_ext_id TEXT,
  callee_ext_number TEXT,
  callee_ext_type TEXT,
  callee_name TEXT,
  callee_email TEXT,

  -- Queue/Operator routing
  operator_ext_id TEXT,
  operator_ext_number TEXT,
  operator_ext_type TEXT,
  operator_name TEXT,

  -- Timing
  start_time TIMESTAMPTZ,
  end_time TIMESTAMPTZ,
  wait_time INTEGER,  -- seconds
  talk_time INTEGER,  -- seconds
  hold_time INTEGER,  -- seconds

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_call_logs_call_id ON rb_call_logs (call_id);
CREATE INDEX idx_call_logs_result ON rb_call_logs (result);

ALTER TABLE rb_call_logs ENABLE ROW LEVEL SECURITY;
```

### `rb_calls_computed` (aggregated per call)

Recomputed on every event. Stores final state + enrichment results.

```sql
CREATE TABLE rb_calls_computed (
  call_id TEXT PRIMARY KEY,

  -- Recomputed fields (updated every event)
  caller_phone_e164 TEXT,
  caller_name TEXT,
  final_result TEXT,  -- best outcome: answered > voicemail > abandoned > no_answer
  answered_by_ext_number TEXT,
  answered_by_name TEXT,
  first_queue TEXT,
  queues_visited TEXT[],
  agents_rang TEXT[],
  total_wait_time INTEGER,
  total_talk_time INTEGER,
  total_hold_time INTEGER,
  call_start_time TIMESTAMPTZ,
  call_end_time TIMESTAMPTZ,

  -- One-time enrichment results (written by async workers)
  enrichment_data JSONB DEFAULT '{}',

  -- Tracking
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE rb_calls_computed ENABLE ROW LEVEL SECURITY;
```

### `rb_enrichment_queue` (trigger table for one-time jobs)

Async work queue for enrichments that should only run once.

```sql
CREATE TABLE rb_enrichment_queue (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id TEXT NOT NULL,
  enrichment_type TEXT NOT NULL,  -- 'ai_caller_name', 'address_lookup', 'title_search', etc.
  status TEXT NOT NULL DEFAULT 'pending',  -- pending, processing, completed, failed
  input_data JSONB,  -- data needed for enrichment
  result_data JSONB,  -- result from enrichment
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ,

  UNIQUE (call_id, enrichment_type)  -- only one of each type per call
);

CREATE INDEX idx_enrichment_queue_status ON rb_enrichment_queue (status) WHERE status = 'pending';

ALTER TABLE rb_enrichment_queue ENABLE ROW LEVEL SECURITY;
```

## Processing Flow

### Hot Path (on every event)

```
phone.callee_call_history_completed arrives
    │
    ├─► INSERT into rb_call_events (raw storage)
    │
    ├─► UPSERT each call_logs entry into rb_call_logs
    │
    ├─► Recompute rb_calls_computed:
    │     SELECT aggregates FROM rb_call_logs WHERE call_id = ?
    │     UPSERT into rb_calls_computed
    │
    └─► Queue enrichments (if not already queued):
          INSERT INTO rb_enrichment_queue (call_id, type, input_data)
          ON CONFLICT DO NOTHING
```

### Async Enrichment Worker (separate Lambda, scheduled or SQS-triggered)

```
Poll rb_enrichment_queue WHERE status = 'pending'
    │
    ├─► Mark as 'processing'
    │
    ├─► Run enrichment (AI call, API lookup, etc.)
    │
    ├─► UPDATE rb_enrichment_queue SET status = 'completed', result_data = ?
    │
    └─► UPDATE rb_calls_computed SET enrichment_data = enrichment_data || ?
```

## Enrichment Types

| Type | Trigger Condition | What It Does |
|------|-------------------|--------------|
| `ai_caller_name` | caller_phone_e164 present | AI lookup/normalization of caller name |
| `address_lookup` | caller identified | Lookup property address from CRM |
| `title_search` | address found | Search property title/owner info |
| `sentiment_analysis` | call answered & recorded | Analyze call recording sentiment |

## Recomputation Logic

Fields that recompute every time (in `rb_calls_computed`):

```sql
-- Pseudocode for recomputation
SELECT
  MAX(caller_phone_e164) as caller_phone_e164,
  MAX(caller_name) as caller_name,
  -- Best result (priority: answered > voicemail > abandoned > no_answer)
  CASE
    WHEN 'answered' = ANY(array_agg(result)) THEN 'answered'
    WHEN 'voicemail' = ANY(array_agg(result)) THEN 'voicemail'
    WHEN 'abandoned' = ANY(array_agg(result)) THEN 'abandoned'
    ELSE MAX(result)
  END as final_result,
  -- Who answered (if anyone)
  (SELECT callee_ext_number FROM rb_call_logs
   WHERE call_id = ? AND result = 'answered' LIMIT 1) as answered_by_ext_number,
  -- Queues
  array_agg(DISTINCT operator_name) FILTER (WHERE operator_ext_type = 'call_queue') as queues_visited,
  -- Agents
  array_agg(DISTINCT callee_name) as agents_rang,
  -- Timing
  SUM(wait_time) as total_wait_time,
  SUM(talk_time) as total_talk_time,
  MIN(start_time) as call_start_time,
  MAX(end_time) as call_end_time
FROM rb_call_logs
WHERE call_id = ?
```

## Files to Create/Modify

1. `src/call-history-processor.ts` - New Lambda for processing call history events
2. `src/enrichment-worker.ts` - New Lambda for async enrichments
3. `serverless.yml` - Add new functions
4. Migrations via Supabase for new tables

## Open Questions

1. Should call history events go through the same ingress/SQS path or a separate endpoint?
2. What's the polling interval for enrichment worker? (Or use SQS?)
3. Which enrichments are MVP vs later?
