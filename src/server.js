const express = require("express");

const { logMessage } = require("./common/logger");
const { connectDB, closeDB } = require("./config/db");

// Load .env only when running locally (not in Lambda)
if (process.env.AWS_LAMBDA_FUNCTION_NAME === undefined) {
  const env = require("./config/env");
  env.loadEnv();
  env.validateEnv();

  connectDB().then(() => {
    logMessage("INFO", "✅ Database connected successfully");
  });
}

const app = express();
const PORT = process.env.PORT || 3000;

const { enforceApiKey } = require("./common/middlewares");

// Middleware to parse JSON requests
app.use(express.json());

// Middleware to strip /prod from path if running in Lambda/API Gateway
if (process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.use((req, res, next) => {
    if (req.url.startsWith("/prod")) {
      req.url = req.url.replace(/^\/prod/, "") || "/";
    }

    next();
  });
}

// Middleware to log API calls
app.use((req, res, next) => {
  const start = Date.now();
  logMessage(
    "INFO",
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - Start`
  );

  res.on("finish", () => {
    const duration = Date.now() - start;
    logMessage(
      "INFO",
      `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms - End`
    );
  });

  next();
});

// QuickBooks routes (API key required, but skip /quickbooks/callback for OAuth)
const quickbooksRouter = require("./routes/quickbooks");
app.use(
  "/quickbooks",
  enforceApiKey({
    skip: [{ path: "/callback", method: "GET" }],
  }),
  quickbooksRouter
);

// Hubspot routes (API key + signature validation)
const hubspotRouter = require("./routes/hubspot");
app.use("/hubspot", enforceApiKey(), hubspotRouter);

// Invoice routes (API key required)
const invoiceRouter = require("./routes/invoice");
app.use("/invoice", enforceApiKey(), invoiceRouter);

// Favicon route to prevent 404s and log noise
app.get("/favicon.ico", (req, res) => {
  res.status(204).end();
});

// Health check route
app.get("/health", enforceApiKey(), (req, res) => {
  res.json({
    status: "✅ healthy",
    timestamp: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.send("✅ QuickBooks Backend is running!");
});

// Error-handling middleware (should be after all routes)
app.use((err, req, res, next) => {
  logMessage("ERROR", `[${req.method}] ${req.originalUrl} -`, err.stack || err);
  res.status(err.status || 500).json({
    error: "Internal Server Error",
    message: err.message || "An unexpected error occurred",
  });

  next();
});

// Only start the server if running locally (not in Lambda)
if (require.main === module) {
  app.listen(PORT, () => {
    logMessage("INFO", `✅ Server is running on port ${PORT}`);
  });
}

// Graceful shutdown
const shutdown = async () => {
  logMessage("INFO", "❌ Shutting down server...");
  await closeDB();
  process.exit(0);
};

process.on("uncaughtException", (err) => {
  logMessage("ERROR", "❌ Uncaught Exception:", err);
  shutdown();
});

process.on("unhandledRejection", (reason, promise) => {
  logMessage("ERROR", "❌ Unhandled Rejection at:", promise, "reason:", reason);
  shutdown();
});

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

module.exports = app;
