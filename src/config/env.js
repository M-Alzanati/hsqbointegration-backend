const dotenv = require("dotenv");

const validateEnv = () => {
  const requiredEnv = [
    "QUICKBOOKS_CLIENT_ID",
    "QUICKBOOKS_CLIENT_SECRET",
    "QUICKBOOKS_ENVIRONMENT",
    "QUICKBOOKS_REDIRECT_URI",
    "QUICKBOOKS_APP_URL",
    "MONGODB_URI",
    "HUBSPOT_API_KEY",
  ];

  const missing = requiredEnv.filter((key) => !process.env[key]);
  if (missing.length) {
    console.error(
      `Missing required environment variables: ${missing.join(", ")}`
    );
    process.exit(1);
  }
};

module.exports = {
  validateEnv,
  loadEnv: () => dotenv.config(),
};
