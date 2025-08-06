const { MongoClient } = require("mongodb");
const {
  SecretsManagerClient,
  GetSecretValueCommand,
} = require("@aws-sdk/client-secrets-manager");
const {
  QB_TOKEN_COLLECTION,
  QB_HUBSPOT_CUSTOMER_COLLECTION,
  QB_INVOICE_COLLECTION,
} = require("../models/constants");

const fs = require("fs");
const path = require("path");
const net = require("net");

// Use shared logger
const { logMessage } = require("../common/logger");

// MongoDB connection URI - you can set this via environment variable
const MONGODB_URI = process.env.MONGODB_URI || "mongodb://localhost:27017";

let dbInstance = null;
let client = null;

// Helper to fetch secret from AWS Secrets Manager
async function fetchDocDBPasswordFromSecretsManager() {
  const secretId =
    process.env.DOCDB_PASSWORD_SECRET_ARN ||
    process.env.DOCDB_PASSWORD_SECRET_NAME;

  if (!secretId) {
    logMessage(
      "ERROR",
      "No DOCDB_PASSWORD_SECRET_ARN or DOCDB_PASSWORD_SECRET_NAME set in environment"
    );
    throw new Error("Missing secret ARN or name for DocumentDB password");
  }

  const client = new SecretsManagerClient({
    region: process.env.AWS_REGION || "us-east-1",
  });

  const command = new GetSecretValueCommand({ SecretId: secretId });
  const response = await client.send(command);
  let password;

  if (response.SecretString) {
    try {
      // Try to parse as JSON, fallback to string
      const parsed = JSON.parse(response.SecretString);
      password = parsed.password || response.SecretString;
    } catch {
      password = response.SecretString;
    }
  } else if (response.SecretBinary) {
    password = Buffer.from(response.SecretBinary, "base64").toString("ascii");
  }

  if (!password)
    throw new Error(
      "Could not retrieve DocumentDB password from Secrets Manager"
    );
  return password;
}

const connectDB = async () => {
  try {
    // Prefer AWS DocumentDB environment variables if present
    const docdbUser = process.env.DOCDB_USERNAME;
    let docdbPass = process.env.DOCDB_PASSWORD;
    const docdbEndpoint = process.env.DOCDB_ENDPOINT;
    const docdbDbName = process.env.DOCDB_DBNAME;

    // If running in AWS and DOCDB_PASSWORD is not set, fetch from Secrets Manager
    if (
      !docdbPass &&
      (process.env.DOCDB_PASSWORD_SECRET_ARN ||
        process.env.DOCDB_PASSWORD_SECRET_NAME)
    ) {
      logMessage(
        "INFO",
        "Fetching DocumentDB password from AWS Secrets Manager..."
      );

      docdbPass = await fetchDocDBPasswordFromSecretsManager();
      process.env.DOCDB_PASSWORD = docdbPass;

      logMessage(
        "INFO",
        "Successfully retrieved DocumentDB password from Secrets Manager"
      );
    }

    if (docdbEndpoint) {
      const testPort = 27017;
      logMessage(
        "INFO",
        `🔍 Testing connectivity to ${docdbEndpoint}:${testPort} ...`
      );

      try {
        await new Promise((resolve, reject) => {
          const socket = net.createConnection(testPort, docdbEndpoint);
          socket.setTimeout(5000);
          socket.on("connect", () => {
            logMessage(
              "INFO",
              `✅ Successfully connected to ${docdbEndpoint}:${testPort}`
            );
            socket.end();
            resolve();
          });

          socket.on("timeout", () => {
            reject(new Error("Timeout"));
            socket.destroy();
          });

          socket.on("error", (err) => {
            reject(err);
          });
        });
      } catch (err) {
        logMessage(
          "ERROR",
          `❌ Cannot connect to ${docdbEndpoint}:${testPort} -`,
          err.message
        );
      }
    }

    let uriToUse = MONGODB_URI;
    let mongoOptions = {
      connectTimeoutMS: 60000,
      serverSelectionTimeoutMS: 60000,
    };

    if (docdbUser && docdbPass && docdbEndpoint && docdbDbName) {
      const user = encodeURIComponent(docdbUser);
      const pass = encodeURIComponent(docdbPass);

      const docdbOptions =
        process.env.DOCDB_OPTIONS ||
        "directConnection=true&tls=true&retryWrites=false&authMechanism=SCRAM-SHA-1&replicaSet=rs0&connectTimeoutMS=30000";
      uriToUse = `mongodb://${user}:${pass}@${docdbEndpoint}:27017/?${docdbOptions}`;

      const caPaths = [
        path.join(__dirname, "global-bundle.pem"),
        path.join(__dirname, "../global-bundle.pem"),
        "/var/task/global-bundle.pem",
      ];

      let foundCA = false;
      for (const caPath of caPaths) {
        if (fs.existsSync(caPath)) {
          mongoOptions = {
            ...mongoOptions,
            tls: true,
            tlsCAFile: caPath,
          };

          logMessage("INFO", `🔍 Using CA file for TLS: ${caPath}`);
          foundCA = true;
          break;
        }
      }

      if (!foundCA) {
        logMessage(
          "WARN",
          `⚠️  global-bundle.pem not found in any known location, proceeding without tlsCAFile`
        );
        mongoOptions = {};
      }

      logMessage("INFO", "🔍 Using AWS DocumentDB connection settings");
    } else {
      const username = process.env.MONGODB_USERNAME;
      const password = process.env.MONGODB_PASSWORD;
      const dbName = process.env.MONGODB_DBNAME;

      if (username || password || dbName) {
        const user = encodeURIComponent(username || "admin");
        const pass = encodeURIComponent(password || "password123");
        const db = dbName || "hubspot_quickbooks";
        uriToUse = `mongodb://${user}:${pass}@localhost:27017/${db}?authSource=admin`;
      }

      logMessage("INFO", "🔍 Using local MongoDB connection settings");
    }

    logMessage(
      "INFO",
      `🔍 Attempting to connect to MongoDB at URI: ${uriToUse}`
    );
    client = new MongoClient(uriToUse, mongoOptions);

    client.on("connect", () => {
      logMessage("INFO", "✅ MongoClient connected successfully");
    });

    client.on("ping", () => {
      logMessage("INFO", "✅ Pinged MongoDB successfully");
    });

    client.on("error", (err) => {
      logMessage("ERROR", "❌ MongoClient error:", err);
    });

    client.on("close", () => {
      logMessage("INFO", "❌❌❌ MongoClient connection closed");
    });

    await client.connect();

    logMessage("INFO", "✅ MongoClient connected");

    // Set dbInstance to the correct database after connecting
    let dbNameToUse = docdbDbName || process.env.MONGODB_DBNAME || undefined;
    if (!dbNameToUse) {
      // Try to parse from URI if not set
      try {
        const match = /\/(\w+)(\?|$)/.exec(uriToUse);
        if (match) dbNameToUse = match[1];
      } catch {
        logMessage(
          "WARN",
          "⚠️ Could not parse database name from URI, using default"
        );
        dbNameToUse = "hubspot_quickbooks"; // Fallback to a default name
      }
    }
    dbInstance = client.db(dbNameToUse);

    try {
      await dbInstance.command({ ping: 1 });
      logMessage("INFO", "✅ Pinged MongoDB successfully (authentication OK)");
    } catch (authErr) {
      logMessage(
        "ERROR",
        "❌ Authentication failed when pinging MongoDB:",
        authErr
      );
      throw authErr;
    }

    if (!(await isMongoInitialized())) {
      logMessage(
        "INFO",
        "🔄 MongoDB not initialized, running initialization script..."
      );
      await initMongo();
    }

    return dbInstance;
  } catch (err) {
    logMessage("ERROR", "❌ DB connection failed:", err);
    process.exit(1);
  }
};

// Get the database instance
const getDB = () => {
  if (!dbInstance) {
    throw new Error("Database not connected. Call connectDB first.");
  }
  return dbInstance;
};

// Close the database connection
const closeDB = async () => {
  try {
    if (client) {
      await client.close();
      logMessage("INFO", "🔒 MongoDB connection closed");
    }
  } catch (err) {
    logMessage("ERROR", "❌ Error closing DB connection:", err);
  }
};

const initMongo = async () => {
  logMessage("INFO", "🔄 Initializing MongoDB collections and indexes...");

  await dbInstance.createCollection(QB_INVOICE_COLLECTION);
  await dbInstance.createCollection(QB_TOKEN_COLLECTION);
  await dbInstance.createCollection(QB_HUBSPOT_CUSTOMER_COLLECTION);

  await dbInstance
    .collection(QB_INVOICE_COLLECTION)
    .createIndex({ invoiceId: 1 }, { unique: true });
  await dbInstance
    .collection(QB_INVOICE_COLLECTION)
    .createIndex({ createdAt: 1 });
  await dbInstance.collection(QB_INVOICE_COLLECTION).createIndex({ status: 1 });

  await dbInstance
    .collection(QB_TOKEN_COLLECTION)
    .createIndex({ userId: 1 }, { unique: true });
  await dbInstance
    .collection(QB_TOKEN_COLLECTION)
    .createIndex({ expiresAt: 1 });

  await dbInstance
    .collection(QB_HUBSPOT_CUSTOMER_COLLECTION)
    .createIndex({ contactId: 1 }, { unique: true });
  await dbInstance
    .collection(QB_HUBSPOT_CUSTOMER_COLLECTION)
    .createIndex({ email: 1 });

  logMessage(
    "INFO",
    "✅ MongoDB initialized successfully for HubSpot-QuickBooks integration"
  );
};

const isMongoInitialized = async () => {
  const requiredCollections = [
    QB_INVOICE_COLLECTION,
    QB_TOKEN_COLLECTION,
    QB_HUBSPOT_CUSTOMER_COLLECTION,
  ];

  const collections = await dbInstance.listCollections().toArray();
  const collectioncollectionNames = collections.map((col) => col.name);

  const allExist = requiredCollections.every((name) =>
    collectioncollectionNames.includes(name)
  );

  return allExist;
};

module.exports = {
  connectDB,
  getDB,
  closeDB,
};
