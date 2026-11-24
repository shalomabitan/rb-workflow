# Onboarding: instructions for the AI agent

You are setting up a new teammate's Mac. Read [AGENTS.md](../AGENTS.md) first.

## How to work with this person

- They are not technical. You do all the work.
- Ask them only for things you cannot do: logins, clicking "Allow", typing their Mac password, copying a key from their password manager.
- When you need them, say exactly what to click or type, in plain words, one step at a time.
- Before each step, say in one sentence what you are about to do and why.
- If something fails, fix it yourself. Tell them only if you are blocked, and name who can unblock it (usually Joel).
- Never ask them to paste a password, key, or code into the chat.

## Setup

Skip any step that is already done. Verify each one.

1. **Tools.** Install what is missing: Homebrew, git, GitHub CLI (`gh`), Node 22, AWS CLI v2. Warn them before Homebrew asks for their Mac password. Show the versions.
2. **Repo.** If you are not already in a clone: `gh auth login` (GitHub.com, HTTPS, browser), then `gh repo clone shalomabitan/rb-workflow ~/code/rb-workflow`. Check out `develop`. If the clone fails with "not found", they have not accepted Joel's GitHub invite yet. Tell them to look for the email from GitHub.
3. **AWS config.** Merge this into `~/.aws/config`. Keep other profiles, and keep these exact names:
   ```
   [sso-session roofbuddy]
   sso_start_url = https://d-9267d0d20c.awsapps.com/start
   sso_region = us-west-2
   sso_registration_scopes = sso:account:access

   [profile roofbuddy-stage]
   sso_session = roofbuddy
   sso_account_id = 488762301321
   sso_role_name = AdministratorAccess
   region = us-west-2

   [profile roofbuddy-prod]
   sso_session = roofbuddy
   sso_account_id = 928621976240
   sso_role_name = AdministratorAccess
   region = us-west-2
   ```
4. **AWS login.** Run `aws sso login --sso-session roofbuddy`.
   - Tell them that a browser opens, and that they sign in with their AWS username, password, and MFA, then click "Allow".
   - If they never set an AWS password, tell them to find the AWS email (from `no-reply@login.awsapps.com`) and to set up MFA when asked. If there is no email, Joel resends it.
   - Verify with `aws sts get-caller-identity --profile roofbuddy-stage` and again with `--profile roofbuddy-prod`.
5. **Dependencies.** Run `npm ci` and `npm run lint`.
6. **Serverless key** (needed to deploy). Joel gives them an access key through a password manager. Save it so that it never passes through the chat:
   1. Tell them to copy the key from their password manager and say "copied".
   2. Run `security add-generic-password -U -a "$USER" -s serverless-roofbuddy -w "$(pbpaste)" && pbcopy < /dev/null`.
   3. Add this line once to `~/.zshrc`: `export SERVERLESS_ACCESS_KEY="$(security find-generic-password -a "$USER" -s serverless-roofbuddy -w 2>/dev/null)"`.
   4. Verify in a new shell: `npx serverless print --stage dev > /dev/null && echo OK`. Never print the key.
   5. If they have no key yet, skip this step. Tell them to ask Joel, and that everything except deploying works without it.
7. **Report.** Tell them in 3 to 5 plain sentences what works and what still needs Joel.
8. Tell them: "Your AWS login lasts 8 hours. Next time, say 'log me back in to AWS'."

## First task: check the Slack delay fix

Slack alerts used to arrive minutes late. A fix went live on 2026-11-24 at 21:04 UTC (see History in AGENTS.md). Find out if it worked and if anything is still slow. Slack should get a message within a few seconds of a Zoom phone event.

1. Read `src/ingress.ts`, `src/processor.ts`, `src/slack.ts`, and `serverless.yml`. Map every step from the webhook to the Slack message.
2. In prod, read only. Use the query in AGENTS.md for the queue wait since the fix. Also measure retries, processor and ingress duration, cold starts (Init Duration), and errors. Check that the DLQ is empty.
3. Compare the results with the baseline in AGENTS.md.
4. Write `docs/slack-delay-findings.md` with two sections:
   - **Summary**: 5 sentences or fewer, no jargon.
   - **Technical details for Joel**: the numbers before and after, example events, and anything still slow, with evidence and a proposed fix.
5. Show them the summary. If a fix is needed, ask if they want you to build it.
6. To build it: make a branch from `develop`, add vitest tests, run lint, commit, push, and open a PR to `develop`.
7. To deploy it: follow "Deploying" in AGENTS.md.
   - Test first.
   - Explain the live change in plain words: what changes, what could go wrong, and how to undo it.
   - Deploy to prod only after they type exactly **deploy to prod**.
   - If something breaks, roll back after they say "roll back", then tell them to message Joel.
