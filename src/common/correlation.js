const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");

// AsyncLocalStorage to keep per-request context (e.g., correlation id)
const als = new AsyncLocalStorage();

function generateId() {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  // Fallback simple unique-ish id
  return (
    Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10)
  );
}

function getStore() {
  return als.getStore() || {};
}

function getCorrelationId() {
  const store = getStore();
  return store.correlationId;
}

// Express middleware to establish a correlation id for each request
function correlationMiddleware(req, res, next) {
  const headerId =
    req.headers["x-correlation-id"] || req.headers["x-request-id"];

  const parent = als.getStore();
  const correlationId =
    (headerId && String(headerId).trim()) ||
    parent?.correlationId ||
    generateId();

  // Expose on req and response header
  req.correlationId = correlationId;
  try {
    res.setHeader("X-Correlation-Id", correlationId);
  } catch {
    // ignore header set errors
  }

  als.run({ correlationId }, () => next());
}

// Utility to run any async function within a correlation context (useful in Lambda entry)
async function runWithCorrelation(correlationId, fn) {
  const id = correlationId || generateId();
  return await als.run({ correlationId: id }, async () => await fn());
}

module.exports = {
  correlationMiddleware,
  getCorrelationId,
  runWithCorrelation,
};
