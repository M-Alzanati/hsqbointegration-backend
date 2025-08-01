const fs = require("fs");

// Logging utility: logs to both console and app.log
const LOG_FILE = "/tmp/app.log";

function logMessage(level, ...args) {
  const msg =
    `[${new Date().toISOString()}] [${level}] ` +
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");

  // Ensure the log directory exists
  if (!fs.existsSync("/tmp")) {
    fs.mkdirSync("/tmp", { recursive: true });
  }

  // Append the log message to the log file
  fs.appendFileSync(LOG_FILE, msg + "\n");

  if (level === "ERROR") {
    console.error(...args);
  } else if (level === "WARN") {
    console.warn(...args);
  } else {
    console.log(...args);
  }
}

module.exports = { logMessage };
