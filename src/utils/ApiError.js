/** An error that is safe to show to the client. Anything else becomes a generic 500. */
export class ApiError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code ?? defaultCode(status);
    this.details = details;
    this.expose = true;
  }

  static badRequest(msg = "Bad request", opts) {
    return new ApiError(400, msg, opts);
  }
  static unauthorized(msg = "Please sign in to continue", opts) {
    return new ApiError(401, msg, opts);
  }
  static forbidden(msg = "You do not have permission to do this", opts) {
    return new ApiError(403, msg, opts);
  }
  static notFound(msg = "Not found", opts) {
    return new ApiError(404, msg, opts);
  }
  static conflict(msg = "Conflict", opts) {
    return new ApiError(409, msg, opts);
  }
  static tooMany(msg = "Too many requests, please try again later", opts) {
    return new ApiError(429, msg, opts);
  }
  static unavailable(msg = "Service temporarily unavailable, please try again", opts) {
    return new ApiError(503, msg, opts);
  }
}

function defaultCode(status) {
  return (
    {
      400: "BAD_REQUEST",
      401: "UNAUTHORIZED",
      403: "FORBIDDEN",
      404: "NOT_FOUND",
      409: "CONFLICT",
      413: "PAYLOAD_TOO_LARGE",
      422: "VALIDATION_ERROR",
      429: "RATE_LIMITED",
      502: "UPSTREAM_ERROR",
      503: "UNAVAILABLE",
    }[status] ?? "ERROR"
  );
}
