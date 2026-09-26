// One error shape for every API route:
//   { success: false, error: "<message>", code: "<machine code>", requestId, details?, unsupported? }
// Success responses keep { success: true, ...payload }.
const { UNIQUE_VIOLATION } = require('../db');

class ApiError extends Error {
  constructor(status, message, { code, details } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new ApiError(400, message, { code: 'bad_request', details });
const forbidden = (message) => new ApiError(403, message, { code: 'forbidden' });
const notFound = (message) => new ApiError(404, message, { code: 'not_found' });
const conflict = (message) => new ApiError(409, message, { code: 'conflict' });

// Turns a unique-constraint violation into a 409 with a readable message.
const onDuplicate = (message) => (err) => {
  if (err.code === UNIQUE_VIOLATION) throw conflict(message);
  throw err;
};

// Errors from upstream calls without their own status become 502 Bad Gateway.
const asUpstream = (err) => {
  if (!err.status) err.status = 502;
  throw err;
};

function statusOf(err) {
  if (err.type === 'entity.parse.failed') return 400;
  if (err.type === 'entity.too.large') return 413;
  const s = Number(err.status || err.statusCode);
  return s >= 400 && s <= 599 ? s : 500;
}

function codeOf(err, status) {
  if (typeof err.code === 'string' && /^[a-z_]+$/.test(err.code)) return err.code;
  if (err.type === 'entity.parse.failed') return 'invalid_json';
  if (status === 413) return 'too_large';
  if (status === 404) return 'not_found';
  return status >= 500 ? 'internal_error' : 'bad_request';
}

function errorHandler() {
  // eslint-disable-next-line no-unused-vars
  return (err, req, res, next) => {
    const status = statusOf(err);
    const code = codeOf(err, status);
    const message = err.type === 'entity.parse.failed' ? 'Request body is not valid JSON' : err.message || 'Internal error';
    // The request log line (src/http/middleware.js) carries the message; unexpected server
    // errors are logged here as well, with the stack.
    res.locals.error = message;
    res.locals.code = code;
    if (status >= 500 && status !== 502 && status !== 503) (req.log || console).error({ err, code }, 'request failed');
    if (res.headersSent) return res.end();
    const body = { success: false, error: message, code, requestId: req.id };
    if (err.details) body.details = err.details;
    if (err.unsupported) body.unsupported = true;
    res.status(status).json(body);
  };
}

const notFoundHandler = (req, res, next) => next(notFound(`No route for ${req.method} ${req.baseUrl}${req.path}`));

module.exports = { ApiError, badRequest, forbidden, notFound, conflict, onDuplicate, asUpstream, errorHandler, notFoundHandler };
