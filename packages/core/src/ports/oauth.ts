/**
 * A provider a venue connects by signing in there (OAuth 2 authorisation-code flow) rather
 * than by pasting a key. Registered under the `oauth` adapter kind with the PLUG's key, so the
 * module that owns the plug finds it with `app.adapters.get('oauth', plug.key)`.
 *
 * The adapter only speaks the protocol with the platform's own application credentials. It
 * never sees the database or the secret store: the calling module stores what comes back
 * through connect() and reads it through resolveConnection().
 */
export interface OAuthTokens {
  accessToken: string;
  /** Null when the provider issues none; the connection then ends when the access token does. */
  refreshToken: string | null;
  expiresAt: Date | null;
  /** The provider's account (merchant) id the tokens act for. */
  externalAccountId: string;
}

export interface OAuthPort {
  key: string;
  /** Renew a token once it has less than this long to live. */
  refreshAheadMs: number;
  /** Where to send the person to sign in and approve. `state` comes back unchanged on the redirect. */
  authorizeUrl(args: { state: string; scopes: string[] }): string;
  exchangeCode(args: { code: string }): Promise<OAuthTokens>;
  /** A new access token. `refreshToken` in the answer is the one to keep (it may be the same one). */
  refresh(args: { refreshToken: string }): Promise<OAuthTokens>;
  /**
   * End access at the provider. `everything` ends every token the account granted this
   * application; otherwise only the one access token. Revoking what is already revoked is not an error.
   */
  revoke(args: { accessToken: string; everything: boolean }): Promise<void>;
  /**
   * What every connection made through this application carries besides the tokens: the
   * platform-level webhook signing secret, the environment, the application id.
   */
  connectionDefaults(): { credentials: Record<string, string>; config: Record<string, unknown> };
}

/**
 * The provider refused the code or the refresh token: the person withdrew access, or the
 * grant ended. Retrying cannot help; the venue has to connect again. Anything else an adapter
 * throws is treated as an outage and retried.
 */
export class OAuthRefusedError extends Error {
  constructor(message = 'The service refused the saved sign-in.') {
    super(message);
    this.name = 'OAuthRefusedError';
  }

  /**
   * Recognised by name, not by class identity. The web build holds more than one copy of this
   * module (the adapter is created in one bundle, the service that catches its error runs in
   * another), and there a plain `instanceof` answered no: a refused code was reported as an outage.
   */
  static override [Symbol.hasInstance](value: unknown): boolean {
    return value instanceof Error && value.name === 'OAuthRefusedError';
  }
}
