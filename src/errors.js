// Fehlerarten, bei denen ein Umzug pausiert statt scheitert.
export class QuotaError extends Error {
  constructor(message, resumeAt) { super(message); this.resumeAt = resumeAt; }
}
export class AuthError extends Error {}
export class OfflineError extends Error {}
