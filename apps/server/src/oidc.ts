import * as client from "openid-client";

export interface OidcConfig {
  /** `https://accounts.google.com` for Google. */
  issuer: string;
  clientId: string;
  clientSecret: string;
}

/** What the server keeps between redirecting out and the provider calling back. */
export interface PendingLogin {
  verifier: string;
  state: string;
  nonce: string;
}

export interface VerifiedIdentity {
  issuer: string;
  subject: string;
  email: string;
  name: string;
  /** Google Workspace domain; absent for personal accounts. */
  hostedDomain: string | null;
}

export type OidcFailure = "email_not_verified" | "email_domain_not_allowed" | "oidc_failed";

/**
 * Sign-in with an OpenID Connect provider: authorization code flow with PKCE,
 * state and nonce. Discovery is fetched on first use and retried after a failure.
 */
export class Oidc {
  private configuration: Promise<client.Configuration> | null = null;

  constructor(
    private readonly config: OidcConfig,
    private readonly allowedDomains: string[],
  ) {}

  private discover(): Promise<client.Configuration> {
    this.configuration ??= client
      .discovery(new URL(this.config.issuer), this.config.clientId, this.config.clientSecret, undefined, {
        // Only the local fake provider is served over plain HTTP.
        execute: new URL(this.config.issuer).protocol === "http:" ? [client.allowInsecureRequests] : [],
      })
      .catch((err: unknown) => {
        this.configuration = null;
        throw err;
      });
    return this.configuration;
  }

  async start(redirectUri: string): Promise<{ url: URL; pending: PendingLogin }> {
    const configuration = await this.discover();
    const pending: PendingLogin = {
      verifier: client.randomPKCECodeVerifier(),
      state: client.randomState(),
      nonce: client.randomNonce(),
    };
    const url = client.buildAuthorizationUrl(configuration, {
      redirect_uri: redirectUri,
      scope: "openid email profile",
      code_challenge: await client.calculatePKCECodeChallenge(pending.verifier),
      code_challenge_method: "S256",
      state: pending.state,
      nonce: pending.nonce,
      prompt: "select_account",
      // A hint for Google's account chooser; the claims are still checked on return.
      ...(this.allowedDomains.length === 1 ? { hd: this.allowedDomains[0]! } : {}),
    });
    return { url, pending };
  }

  async finish(callbackUrl: URL, pending: PendingLogin): Promise<VerifiedIdentity | OidcFailure> {
    let claims: client.IDToken | undefined;
    try {
      const tokens = await client.authorizationCodeGrant(await this.discover(), callbackUrl, {
        pkceCodeVerifier: pending.verifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true,
      });
      claims = tokens.claims();
    } catch {
      return "oidc_failed";
    }
    if (!claims || typeof claims.email !== "string") return "oidc_failed";
    if (claims.email_verified !== true) return "email_not_verified";

    const email = claims.email.toLowerCase();
    const hostedDomain = typeof claims.hd === "string" ? claims.hd.toLowerCase() : null;
    // Both must match: `hd` proves a Workspace account, the email that it is the one shown.
    if (
      this.allowedDomains.length > 0 &&
      !(hostedDomain && this.allowedDomains.includes(hostedDomain) && email.endsWith(`@${hostedDomain}`))
    ) {
      return "email_domain_not_allowed";
    }
    return {
      issuer: claims.iss,
      subject: claims.sub,
      email,
      name: (typeof claims.name === "string" && claims.name.trim()) || email.split("@")[0]!,
      hostedDomain,
    };
  }
}
