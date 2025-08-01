const { logMessage } = require("./common/logger");
logMessage('INFO', "[lambda.js] Lambda module loaded (cold start)");
const serverlessExpress = require("@vendia/serverless-express");
const app = require("./server");
const { connectDB } = require("./config/db");

let cachedHandler;
let isColdStart = true;

exports.handler = async (event, context) => {
  const invocationType = isColdStart ? "COLD START" : "WARM START";
  logMessage('INFO', `[lambda.js] Lambda handler invoked (${invocationType})`);
  logMessage('INFO', "[lambda.js] Event:", JSON.stringify(event));

  try {
    if (!cachedHandler) {
      // Ensure DB is connected before creating the handler (cold start)
      await connectDB();
      cachedHandler = serverlessExpress({ app });
      isColdStart = false;
    }

    const response = await cachedHandler(event, context);
    logMessage('INFO', "[lambda.js] Response:", JSON.stringify(response));

    return response;
  } catch (err) {
    logMessage('ERROR', "[lambda.js] ERROR:", err && err.stack ? err.stack : err);
    logMessage('ERROR', "[lambda.js] Event on error:", JSON.stringify(event));

    return {
      statusCode: 500,
      body: JSON.stringify({
        error: "Internal server error",
        message: err && err.message ? err.message : String(err),
        stack: err && err.stack ? err.stack : undefined,
      }),
    };
  }
};
