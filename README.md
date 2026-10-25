# Booran SMS Test Lab

A standalone test interface styled after Booran Sales Floor. Send real Mobile Message SMS, see carrier delivery results, reply from a handset into the same conversation, and test a six-digit verification SMS on a public Booran verification page. The provider account is shared with Sales Floor; the app, login, database and history are separate.

Production site: **https://booran-sms-test.vercel.app**. Set `APP_URL=https://booran-sms-test.vercel.app` locally and in Vercel so SMS verification links use this domain.

## Local setup

The complete frontend is included in `public/`: a Sales Floor-style sign-in screen, graphite sidebar, responsive conversation inbox, live message status cards, sender connection screen, quick-message templates and a manager testing guide. The phone verification page uses the same Booran branding. The frontend uses plain HTML/CSS/JavaScript, served by the Express API on one origin, with no separate frontend deployment needed.

Requires Node.js 22 and MongoDB access.

```powershell
cd D:\booran-salesfloor\booran-sms-lab
npm ci
npm run setup:local
npm start
```

Open http://localhost:3100. The setup command copies only the existing backend's MongoDB connection and Mobile Message username/password/sender into this project's ignored `.env`, generates a new workspace password and signing secret, and does not overwrite an existing `.env`. Read `SMS_LAB_PASSWORD` there to sign in. An optional source environment path can be passed with `npm run setup:local -- ../other-backend/.env`.

The workspace already includes a locally configured `.env` when created in the supplied workspace. Skip `setup:local` if it exists. Secrets are never included in the browser bundle or this README. Use `.env.example` when setting up elsewhere.

Database configuration uses **one variable only**, `MONGOURI`, including the database name in the URI:

```dotenv
MONGOURI=mongodb+srv://USER:PASSWORD@HOST/booran_sms_lab?retryWrites=true&w=majority
```

The setup script replaces the source URI's database path with `/booran_sms_lab` and preserves its credentials, host and query options. There is no separate database-name setting.

## Vercel deployment

Import [macworldgithub/booran-sms-test](https://github.com/macworldgithub/booran-sms-test) as a **separate Vercel project**. Leave Root Directory at the repository root (`.`), select Framework Preset **Other**, Node.js **22.x**, and use the checked-in `vercel.json`. `api/index.js` serves Express, the complete frontend and all APIs on the same origin; the function includes `public/**`. The build command checks JavaScript and deployment assets. Leave Output Directory at its default. For a parent workspace containing multiple projects, use `booran-sms-lab` as the root instead.

Set these environment variables in Vercel using the corresponding local `.env` values:

| Variable | Purpose |
| --- | --- |
| `MONGOURI` | MongoDB connection string containing `/booran_sms_lab`; same cluster credentials as Sales Floor |
| `MOBILEMESSAGE_USERNAME` | Same Mobile Message username as Sales Floor |
| `MOBILEMESSAGE_PASSWORD` | Same Mobile Message password/API key as Sales Floor |
| `MOBILEMESSAGE_SENDER_ID` | The only allowed sender; fixed by the server and read-only in the interface |
| `SMS_LAB_PASSWORD` | Separate workspace password, at least 10 characters |
| `SMS_LAB_SESSION_SECRET` | Random signing secret, at least 32 characters |
| `APP_URL` | `https://booran-sms-test.vercel.app` — canonical public HTTPS URL for verification links |

`MOBILEMESSAGE_API_KEY` and `MOBILEMESSAGE_FROM` are supported aliases. Never make any credential a public/frontend environment variable. Vercel does not upload local `.env` automatically. Ensure your MongoDB user can create/read/write the separate database and your cluster permits Vercel connections. This project requires `MONGOURI` to select exactly `booran_sms_lab`; an absent database name or a CRM database name is rejected before connecting.

Set `APP_URL=https://booran-sms-test.vercel.app` in Vercel before deploying. Changes to Vercel environment variables apply to a new deployment, so redeploy after updating an existing deployment's variables. If using a custom domain later, connect it in Vercel and set `APP_URL` to that domain. Vercel HTTPS secures the site; it does **not** register/approve a branded SMS sender or verify ownership of a business with Mobile Message. Sender approval must already exist on the provider account. `/api/health` returns 200 only when the database, workspace login and SMS credentials are configured; it does not send a message or confirm provider authentication. Use `npm run check:provider` for a read-only credential/sender check.

For a publicly accessible verification link, avoid Vercel deployment protection on the canonical domain or allow `/verify/*`, `/api/verify/*`, `/styles.css`, `/verify.js`, `/favicon.png` and `/booran-logo.png` through it. The inbox and sending APIs retain their own password login. Recipients do not need a workspace account. Localhost links cannot be opened on another phone; use the deployed HTTPS URL for handset testing. When running locally with the production `APP_URL`, the phone link opens the deployed app; both instances must use the same `MONGOURI` database and `SMS_LAB_SESSION_SECRET` for that verification code to work.

## Manager acceptance test

1. Sign in and start a conversation with a mobile number you control.
2. Send a message from the configured sender and check that the expected sender appears on the phone. Watch queued → sent → delivered when the carrier reports it. Queued means provider acceptance, not handset delivery.
3. With a reply-capable configured sender, send another message, reply from the phone to that number, and keep the conversation open. Polling runs every five seconds; provider inbox/delivery checks are limited to roughly every 15 seconds. The reply appears in that same thread. Send a reply back from the app.
4. Click **Send verification SMS**. Open the link on the phone and enter the six-digit code from the SMS within ten minutes. The interface shows the phone as verified and adds a verification event to its thread. Codes/links are omitted from server history and UI responses. Links are single use with at most five guesses. This verifies possession of the test phone, not the SMS brand or business.
5. Refresh/reopen the site and confirm the thread persists. Test a second number to confirm histories stay separate. Failed and unconfirmed attempts remain visible. Check Mobile Message before deliberately sending a new message after an unconfirmed attempt.

### Sender behavior matters

The app validates only `MOBILEMESSAGE_SENDER_ID` using Mobile Message's API. Other account senders are never exposed to the browser or selectable. Every text and verification SMS uses the environment-configured sender; the API rejects attempts to override it. Business-name (`alpha`) senders are **one-way**: phones cannot reply to the branded name. Shared and dedicated numbers route replies through Mobile Message. An `own` mobile sender routes replies to that physical phone, not this inbox. The UI explains the selected sender's behavior. Branding in the SMS body and the Booran verification page can be used with a two-way number. A shared number supports replies only after an outgoing SMS. No new numbers are purchased or sender registrations changed by this project.

See [Mobile Message sender options](https://help.mobilemessage.com.au/sending-receiving-sms/choosing-a-sender-what-are-the-options) and the [API documentation](https://mobilemessage.com.au/api-documentation).

## Persistence and reliability

MongoDB holds `threads`, `messages`, `verifications` and expiring `limits` in the separate test database. One thread per normalized Australian mobile. The interface lists up to 200 threads and the latest 300 messages per thread; metric cards describe that thread's visible history. Verification records expire with a TTL index and are also checked against their exact expiry during use.

Sends are claimed atomically by request UUID **before** the provider call. Repeating the same UUID cannot send a second SMS, including after a timeout, concurrent submissions or a server restart. A different payload cannot reuse a UUID. Indeterminate acceptance stays unconfirmed and is reconciled by provider ID/custom reference; it is never automatically resent. Provider credits are used for actual sends. The browser retains the request ID for an unchanged failed HTTP attempt until the page closes; reopening the page requires checking saved history before attempting a new send.

Replies are fetched using the authenticated inbound API without consuming the inbox or changing the existing Sales Floor/Delivery Centre webhook. Only a reply matching this app's outgoing provider ID/custom reference **and both sending/receiving numbers** is imported. Shared-account traffic and unrelated CRM messages are excluded. Provider IDs deduplicate overlapping inbox reads. Sync checkpoints advance only after a complete scan; the last UTC day overlaps to catch late replies. Bounded scans display a warning on failures and preserve saved history. Opt-out replies disable further sending in that thread. Keep a test phone's traffic exclusive to this app during an acceptance test: Mobile Message may associate a reply with the most recent send from another app using the same sender.

The password-protected workspace uses signed, HttpOnly, SameSite cookies (Secure on Vercel), eight-hour sessions, same-origin write checks and MongoDB-backed login/send limits. Rotate the signing secret to invalidate sessions. It is an internal testing workspace with a shared team password, not a full staff identity/role system. Do not import customer data into it.

## Checks

```powershell
npm test
npm run build
npm run check:provider
```

Automated tests use an isolated in-memory database and fake provider. They do not send real SMS or touch live CRM data. `check:provider` reads active senders and pings MongoDB, with no SMS send or production record writes. A real end-to-end send/reply test requires the deployed HTTPS URL and a test handset.
