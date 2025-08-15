const fs = require("fs");
const { getCorrelationId } = require("./correlation");

// Logging utility: logs to both console and app.log
const LOG_FILE = "/tmp/app.log";

function logMessage(level, ...args) {
  const correlationId = getCorrelationId();

  const prefixParts = [
    `[${new Date().toISOString()}]`,
    `[${level}]`,
    correlationId ? `[cid:${correlationId}]` : undefined,
  ].filter(Boolean);

  const msg =
    prefixParts.join(" ") +
    " " +
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  // Ensure the log directory exists
  if (!fs.existsSync("/tmp")) {
    fs.mkdirSync("/tmp", { recursive: true });
  }

  // Append the log message to the log file
  fs.appendFileSync(LOG_FILE, msg + "\n");

  // Mirror to console with correlation id prefix for CloudWatch
  const consoleArgs = [correlationId ? `(cid:${correlationId})` : undefined]
    .filter(Boolean)
    .concat(args);

  if (level === "ERROR") {
    console.error(...consoleArgs);
  } else if (level === "WARN") {
    console.warn(...consoleArgs);
  } else {
    console.log(...consoleArgs);
  }
}

module.exports = { logMessage };
