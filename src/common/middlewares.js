const { logMessage } = require("../common/logger");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");

// --- API Key Middleware with skip option ---
function enforceApiKey(options = {}) {
  const { skip = [] } = options;

  // In-memory cache for API key and its expiration
  let cachedApiKey = null;
  let cacheExpiresAt = 0;

  // TTL for cache in ms (default: 10 minutes)
  const CACHE_TTL = 10 * 60 * 1000;

  async function getApiKeyCached() {
    // Prefer env var always
    if (process.env.API_KEY) {
      return process.env.API_KEY;
    }

    // Use cache if valid
    if (cachedApiKey && Date.now() < cacheExpiresAt) {
      return cachedApiKey;
    }

    // Fetch from Secrets Manager
    if (!process.env.API_KEY_SECRET_NAME) {
      return null;
    }

    try {
      const client = new SecretsManagerClient({
        region: process.env.AWS_REGION || "us-east-1",
      });

      const command = new GetSecretValueCommand({
        SecretId: process.env.API_KEY_SECRET_NAME,
      });

      const response = await client.send(command);
      if (response.SecretString) {
        let key;

        try {
          const parsed = JSON.parse(response.SecretString);
          key = parsed.API_KEY || response.SecretString;
        } catch {
          key = response.SecretString;
        }

        cachedApiKey = key;
        cacheExpiresAt = Date.now() + CACHE_TTL;
        return key;
      }

      return null;
    } catch (e) {
      logMessage(
        "ERROR",
        "Failed to fetch API_KEY from Secrets Manager:",
        e.message
      );
      return null;
    }
  }

  return async function (req, res, next) {
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
    const expectedApiKey = await getApiKeyCached();

    if (!expectedApiKey) {
      logMessage("WARN", "API_KEY not set in environment or Secrets Manager");
      return res.status(500).json({ error: "❌ Server misconfiguration" });
    }

    if (!apiKey || apiKey !== expectedApiKey) {
      return res.status(401).json({ error: "❌ Invalid or missing API key" });
    }
    
    next();
  };
}

module.exports = {
  enforceApiKey,
};
