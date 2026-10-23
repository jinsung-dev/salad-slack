# Google sign-in

Chatter signs people in with Google (OpenID Connect: authorization code flow
with PKCE, state and nonce). There are no passwords. With
`ALLOWED_EMAIL_DOMAINS=saladlab.co`, only Google Workspace accounts of that
domain get in: the ID token's `hd` claim and verified email must both match.

Without `OIDC_ISSUER`, the server runs a fake provider in-process for local
development, where you can type any email. It refuses to start that way when
`HOST` accepts other machines.

## 1. Create the OAuth client (Google Cloud Console)

1. Open the Google Cloud Console with your company Google account and pick or
   create a project.
2. **Google Auth Platform → Branding / Audience**: choose **Internal** as the
   user type. Internal apps admit only accounts of your Workspace organization.
3. **Clients → Create client → Web application**.
4. **Authorized redirect URI**: `https://<host>/api/auth/oidc/callback`, for
   example `https://chatter.saladlab.co/api/auth/oidc/callback`.
   Google accepts only HTTPS with a real domain name here; `http://` is allowed
   for `localhost` alone, and raw IP addresses such as `192.168.0.202` are
   rejected.
5. Copy the client ID and client secret.

## 2. Configure Chatter

```bash
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=<client id>
OIDC_CLIENT_SECRET=<client secret>
PUBLIC_URL=https://chatter.saladlab.co   # must match the redirect URI's origin
ALLOWED_EMAIL_DOMAINS=saladlab.co
COOKIE_SECURE=true                       # served over HTTPS
TRUST_PROXY=true                         # when a reverse proxy terminates TLS
```

Keep the client secret out of git; `.env` is ignored.

## Error codes on the sign-in page

| `/login?error=` | Meaning |
| --- | --- |
| `email_domain_not_allowed` | Not a Workspace account of an allowed domain |
| `email_not_verified` | Google reports the email as unverified |
| `account_conflict` | The email belongs to an account linked to a different Google account |
| `login_expired` | The 10-minute sign-in window passed, or cookies are blocked |
| `oidc_failed` | The provider refused, the user cancelled, or the response failed checks |
| `rate_limited` | More than `AUTH_RATE_LIMIT_PER_MINUTE` attempts from one address |
