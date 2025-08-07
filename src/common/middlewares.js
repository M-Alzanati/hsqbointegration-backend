const { logMessage } = require("../common/logger");

// --- API Key Middleware with skip option ---
function enforceApiKey(options = {}) {
  const { skip = [] } = options;

  return function (req, res, next) {
    // Check if this path+method should be skipped
    const shouldSkip = skip.some((rule) => {
      if (typeof rule === "string") {
        return req.path === rule;
      } else if (rule && typeof rule === "object") {
        return (
          req.path === rule.path && (!rule.method || req.method === rule.method)
        );
      }
      return false;
    });

    if (shouldSkip) {
      return next();
    }

    const apiKey = req.headers["x-api-key"];

    if (!process.env.API_KEY) {
      logMessage("WARN", "API_KEY not set in environment");
      return res.status(500).json({ error: "❌ Server misconfiguration" });
    }
    if (!apiKey || apiKey !== process.env.API_KEY) {
      return res.status(401).json({ error: "❌ Invalid or missing API key" });
    }

    next();
  };
}

module.exports = {
  enforceApiKey,
};
