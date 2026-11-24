# rb-workflow: notes for AI agents

Read this before you change, deploy, or investigate anything.
First-time setup on a new machine: follow [docs/onboarding.md](docs/onboarding.md).

## What this is

Zoom Phone events → Slack, Monday.com, Supabase, and a LIFX bulb, for the Roof Buddy call center.

```
Zoom webhook → ingress Lambda → SQS FIFO (group = call_id) → processor Lambda → Slack / Monday / Supabase
                    └→ LIFX bulb (MAIN-queue rings)                     DLQ → dlqAlert Lambda → Slack
```

- Code: `src/` (TypeScript, Node 22). Infra: `serverless.yml` (Serverless Framework v4, org `roofbuddy`).
- Work on `develop`. `main` is stale.
- Region: **us-west-2** for everything.

## Accounts and access

AWS access is through IAM Identity Center (SSO): start URL `https://d-9267d0d20c.awsapps.com/start`, SSO region us-west-2.

| Profile | Account | Use |
|---|---|---|
| `roofbuddy-stage` | 488762301321 | Test stack `sls-zoom-workflow-dev` |
| `roofbuddy-prod` | 928621976240 | Live stack `sls-zoom-workflow-prod`. Also owns Identity Center. |

Login: `aws sso login --sso-session roofbuddy` (sessions last 8 hours).

Serverless v4 refuses every command (deploy, package, print, offline) without `serverless login` or `SERVERLESS_ACCESS_KEY`.

## Deploying

| Target | Command |
|---|---|
| Test | `npm run deploy` |
| Live | `npm run deploy:prod` |

- `serverless.yml` maps the stage to the AWS profile (`custom.awsProfile`). `AWS_PROFILE` does not change where a deploy goes. An unmapped stage fails on purpose.
- `deploy:prod` refuses to run with uncommitted changes. Deploy prod only from a commit pushed to GitHub.
- Before a prod deploy: run `npx serverless package --stage prod --package /tmp/pkg-prod`, confirm the template says 928621976240, and diff it against `aws cloudformation get-template --stack-name sls-zoom-workflow-prod`. Stop and ask a human if `EventsQueue`, `EventsDLQ`, or `HttpApi` would be replaced. A new queue loses messages, and a new API changes the Zoom webhook URL.
- Rollback: `npx serverless deploy list --stage prod` lists the timestamps, then run `npx serverless rollback --stage prod --timestamp <ts>`.
- After a prod deploy, watch Lambda errors, DLQ depth, and queue wait for 15 minutes.

## Hazards

- **The test stack writes to the prod database.** Both accounts use the same Supabase project. Only the Slack channel differs. Do not send test events to the dev stack, except `test-events/http-crc-challenge.json` (the Zoom CRC check, no writes).
- **There are no automated tests.** `npm test` exits with "No test files found". `npm run lint` (tsc) is the only check. Add vitest tests with new code.
- **FIFO blocking.** A message that fails waits for the 90-second visibility timeout and blocks the later events of the same call. Never `await` a slow or flaky optional call in the processor before Slack. Never let it throw.
- **Stray stack.** The stage account has a stack named `sls-zoom-workflow-prod`, left from a 2026 deploy that went to the wrong account. Do not use, change, or delete it without a human's OK.
- SSM parameters live under `/zoom-workflow/` in each account. Do not print SecureString values.

## Measuring the Slack delay

For each event it processes, the processor logs one JSON line: `{"metric":"processed","event_type",...,"queue_wait_ms","process_ms","receive_count"}`. A failed event does not get this line; it logs `Failed to process record`. Run this in Logs Insights on `/aws/lambda/sls-zoom-workflow-prod-processor`:

```
filter @message like /"metric":"processed"/
| parse @message /"queue_wait_ms":(?<wait>-?\d+)/
| parse @message /"process_ms":(?<proc>\d+)/
| parse @message /"receive_count":(?<rcount>\d+)/
| stats count() as n, pct(wait,50) as wait_p50, pct(wait,90) as wait_p90, max(wait) as wait_max,
        pct(proc,50) as proc_p50, pct(proc,95) as proc_p95 by rcount
```

A receive count above 1 means a retry. Each retry adds 90 seconds or more. Logs from before 2026-11-24 use a different format: a `SQS_EVENT_PAYLOAD` line that holds `SentTimestamp`.

## History

- **2026-11-24:** `deploy:prod` had deployed to the stage account since April, so prod ran January code. That code awaited a Zapier webhook that returned 404 (113 retries in 7 days) and also had a fixed 2-second sleep. The baseline over 7 days was a queue wait of p50 80s, p90 246s, and max 484s. Commit f544291 fixed the deploy target, and `develop` was deployed to prod at 21:04 UTC. The pre-deploy code is saved on Joel's machine.
