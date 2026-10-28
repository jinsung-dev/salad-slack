# Email sign-in for outside guests

People at the company domains (`ALLOWED_EMAIL_DOMAINS`) sign in with Google.
People outside it — partners, contractors — have no account with the company
Google Workspace, so they sign in with a six-digit code mailed to them. Google
stays restricted to the company and `ALLOWED_EMAIL_DOMAINS` stays as it is.

## How it works

1. An admin opens **외부인 초대** in a channel and enters the partner's email.
   The link is single-use, valid 7 days, for that address only.
2. The partner opens the link, chooses **이메일 코드로 로그인**, and enters the
   invited address. Chatter mails a code (valid 10 minutes, one use).
3. With the code they get a guest account and join that channel only.
4. Later they sign in from the sign-in page with the same address: codes go
   only to addresses that already have a guest account.

Rules:

- Codes are sent only to the address of an email-bound **guest** invite, or to
  an existing guest account. Company addresses and accounts that signed in
  with Google are told to use Google. Without an invite, the response is the
  same whether or not the address has an account.
- One code per minute and five per hour per address; only the newest code
  works; five wrong tries end it.
- Accounts created this way are **guest only**: they cannot create or join
  workspaces on their own, accept member or admin invites, or be promoted.
  The admin page shows them as "외부 게스트".

## Mail account (Google Workspace)

Use a company account and an app password on `smtp.gmail.com:465`:

1. Turn on 2-Step Verification for the account that sends the mail.
2. Create an app password at <https://myaccount.google.com/apppasswords>.
   If the page is unavailable, the Workspace admin has disabled app passwords;
   use the SMTP relay or another provider instead (`SMTP_HOST`, `SMTP_PORT`).
3. Put it in `.env` (never in git or chat), then restart the server:

```bash
SMTP_USER=chatter@saladlab.co
SMTP_PASSWORD=<16-character app password, no spaces>
# optional
MAIL_FROM=Chatter <chatter@saladlab.co>
```

The startup log says `guest email sign-in via smtp.gmail.com`. Without these
variables email sign-in is off and the sign-in page reports it.

## Mail account (Brevo)

Brevo's free plan sends 300 mails a day over SMTP. In Brevo, **SMTP & API →
SMTP** shows the server, port and login; generate an **SMTP key** there (an API
key does not work). Add the From address under **Senders, Domains** and verify
it; authenticating the domain (Brevo's SPF/DKIM records in its DNS) keeps codes
out of spam.

```bash
SMTP_HOST=smtp-relay.brevo.com
SMTP_PORT=587
SMTP_USER=<login shown on the SMTP tab>
SMTP_PASSWORD=<SMTP key>
MAIL_FROM=Chatter <verified-sender@saladlab.co>
```

Port 587 upgrades with STARTTLS, which Chatter requires; 465 uses TLS from the start.

## Development

With the fake sign-in provider (no `OIDC_ISSUER`) and no SMTP settings, mail is
written as JSON files to `DEV_MAIL_DIR` (default `data/dev-mail`) instead of
being sent. E2E reads codes from there.

## Error codes

| `error` | Meaning |
| --- | --- |
| `invite_for_other_email` | Not the invited address, or not an email-bound guest invite |
| `invite_invalid` | The invite expired, was revoked or used |
| `use_provider` | A company address or Google account: sign in with Google |
| `email_login_disabled` | No SMTP configured |
| `email_send_failed` | The mail server refused or timed out; no code was created |
| `rate_limited` | Asked again within a minute, or more than five codes in an hour |
| `invalid_code` / `code_expired` | Wrong code / expired, used, replaced or out of tries |
| `guest_account_only` | A guest account tried to create a workspace, accept a non-guest invite or be promoted |
