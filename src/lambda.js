const { logMessage } = require("./common/logger");
const { runWithCorrelation } = require("./common/correlation");
logMessage("INFO", "[lambda.js] Lambda module loaded (cold start)");
const serverlessExpress = require("@vendia/serverless-express");
const app = require("./server");
const { connectDB } = require("./config/db");

let cachedHandler;
let isColdStart = true;

exports.handler = async (event, context) => {
  // Try to extract an incoming correlation id from API Gateway event
  const headers = (event && (event.headers || event.multiValueHeaders)) || {};
  let incomingCid =
    headers["x-correlation-id"] ||
    headers["X-Correlation-Id"] ||
    headers["x-request-id"] ||
    headers["X-Request-Id"] ||
    undefined;

  if (
    !incomingCid &&
    event &&
    event.requestContext &&
    event.requestContext.requestId
  ) {
    incomingCid = event.requestContext.requestId;
  }

  return runWithCorrelation(incomingCid, async () => {
    const invocationType = isColdStart ? "COLD START" : "WARM START";
    logMessage(
      "INFO",
      `[lambda.js] Lambda handler invoked (${invocationType})`
    );
    logMessage("INFO", "[lambda.js] Event:", JSON.stringify(event));

    try {
      if (!cachedHandler) {
        // Ensure DB is connected before creating the handler (cold start)
        await connectDB();
        cachedHandler = serverlessExpress({ app });
        isColdStart = false;
      }

      const response = await cachedHandler(event, context);
      logMessage("INFO", "[lambda.js] Response:", JSON.stringify(response));

      return response;
    } catch (err) {
      logMessage(
        "ERROR",
        "[lambda.js] ERROR:",
        err && err.stack ? err.stack : err
      );
      logMessage("ERROR", "[lambda.js] Event on error:", JSON.stringify(event));

      return {
        statusCode: 500,
        body: JSON.stringify({
          error: "Internal server error",
          message: err && err.message ? err.message : String(err),
          stack: err && err.stack ? err.stack : undefined,
        }),
      };
    }
  });
};
