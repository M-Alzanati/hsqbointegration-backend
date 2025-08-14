"use strict";

const { logMessage } = require("./common/logger");
const { invalidateGlobalToken } = require("./services/quickbooksService");

// Lambda handler to invalidate the global QuickBooks token.
// Invoke from AWS Console and pass event like: { "mode": "expire|refreshNow|revoke" }
exports.handler = async (event = {}) => {
  const mode = (event && event.mode) || process.env.INVALIDATE_MODE || "expire";

  try {
    logMessage("INFO", "🔄 Admin invalidate token invoked", { mode });
    const result = await invalidateGlobalToken(mode);
    
    logMessage("INFO", "✅ Admin invalidate token result", result);
    return { statusCode: 200, body: JSON.stringify(result) };
  } catch (e) {
    logMessage("ERROR", "❌ Admin invalidate token failed", e?.message || e);
    
    return {
      statusCode: 500,
      body: JSON.stringify({ success: false, error: e.message || String(e) }),
    };
  }
};
