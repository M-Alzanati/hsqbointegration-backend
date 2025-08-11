const { SecretsManagerClient, GetSecretValueCommand } = require("@aws-sdk/client-secrets-manager");

// Simple in-memory cache: secretName -> { value: string, parsed: object|null, expiresAt: number }
const cache = new Map();
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getClient() {
  return new SecretsManagerClient({ region: process.env.AWS_REGION || "us-east-1" });
}

async function fetchSecretRaw(secretName) {
  const client = getClient();
  const cmd = new GetSecretValueCommand({ SecretId: secretName });
  const res = await client.send(cmd);
  if (res.SecretString) return res.SecretString;
  if (res.SecretBinary) return Buffer.from(res.SecretBinary, "base64").toString("utf-8");
  return null;
}

function parseIfJson(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function getSecretCached(secretName, ttlMs = DEFAULT_TTL_MS) {
  const now = Date.now();
  const hit = cache.get(secretName);
  if (hit && hit.expiresAt > now) {
    return hit;
  }
  const raw = await fetchSecretRaw(secretName);
  const parsed = typeof raw === "string" ? parseIfJson(raw) : null;
  const entry = { value: raw, parsed, expiresAt: now + ttlMs };
  cache.set(secretName, entry);
  return entry;
}

// Tries candidate fields if secret is JSON, else returns raw string
async function getSecretStringFlexible(secretName, candidateFields = [], ttlMs = DEFAULT_TTL_MS) {
  if (!secretName) return null;
  const { value, parsed } = await getSecretCached(secretName, ttlMs);
  if (parsed && typeof parsed === "object") {
    for (const key of candidateFields) {
      if (Object.prototype.hasOwnProperty.call(parsed, key) && parsed[key]) {
        return String(parsed[key]);
      }
    }
    // If object has a single key, return its value
    const keys = Object.keys(parsed);
    if (keys.length === 1) {
      return String(parsed[keys[0]]);
    }
  }
  return typeof value === "string" ? value : null;
}

module.exports = {
  getSecretStringFlexible,
};
