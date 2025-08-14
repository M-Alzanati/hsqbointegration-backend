const OAuthClient = require("intuit-oauth");
const QuickBooks = require("node-quickbooks");
const { getDB } = require("../config/db");
const {
  QB_TOKEN_COLLECTION,
  QB_HUBSPOT_CUSTOMER_COLLECTION,
} = require("../models/constants");
const { QUICKBOOKS_APP_URL } = require("../models/urls");
const { logMessage } = require("../common/logger");
const { toCamelCase } = require("../common/helpers");
const { getSecretStringFlexible } = require("../common/secrets");

// Lazy-loaded credentials and OAuth client
let cachedQBClientId = null;
let cachedQBClientSecret = null;
let credsLoadedAt = 0;
let cachedOAuthClient = null;
// Allow override via env QUICKBOOKS_CREDS_TTL_MS (ms)
const CREDS_TTL =
  Number(process.env.QUICKBOOKS_CREDS_TTL_MS) > 0
    ? Number(process.env.QUICKBOOKS_CREDS_TTL_MS)
    : 10 * 60 * 1000; // default 10 minutes

function resetQbCredsCache() {
  cachedQBClientId = null;
  cachedQBClientSecret = null;
  credsLoadedAt = 0;
  cachedOAuthClient = null;
}

function isInvalidClientError(err) {
  // Detect 401 invalid_client patterns from axios/intuit-oauth
  const status = err?.response?.status || err?.statusCode;
  const errCode = err?.response?.data?.error || err?.error;
  const msg = err?.response?.data?.error_description || err?.message || "";
  return (
    status === 401 &&
    (errCode === "invalid_client" || /invalid[_\s-]?client/i.test(msg))
  );
}

// Cache for TaxCode lookup (e.g., GST/HST)
let cachedTaxCodeId = null;
let taxCodeCachedAt = 0;
const TAXCODE_TTL = 6 * 60 * 60 * 1000; // 6 hours

// Global (single-company) token support
const GLOBAL_TOKEN_KEY = process.env.QBO_GLOBAL_TOKEN_KEY || "GLOBAL";

async function getGlobalTokenDoc(db) {
  // Prefer a single shared token document
  let doc = await db
    .collection(QB_TOKEN_COLLECTION)
    .findOne({ key: GLOBAL_TOKEN_KEY });
  return doc || null;
}

async function upsertGlobalToken(db, tokenObj) {
  const payload = {
    ...toCamelCase(tokenObj || {}),
    key: GLOBAL_TOKEN_KEY,
    updatedAt: new Date(),
  };

  await db
    .collection(QB_TOKEN_COLLECTION)
    .updateOne({ key: GLOBAL_TOKEN_KEY }, { $set: payload }, { upsert: true });

  return payload;
}

/**
 * Invalidate the global QuickBooks token.
 * Modes:
 *  - expire (default): mark access token as expired to force a refresh on next use
 *  - refreshNow: immediately refresh using the stored refresh token
 *  - revoke: remove access and refresh tokens (requires re-auth)
 */
async function invalidateGlobalToken(mode = "expire") {
  const db = getDB();
  const tokenDoc = await getGlobalTokenDoc(db);
  if (!tokenDoc) {
    logMessage("WARN", "⚠️ No global QuickBooks token found to invalidate");
    return { success: false, status: 404, message: "No global token found" };
  }

  if (mode === "refreshNow") {
    logMessage(
      "INFO",
      "🔄 Forcing immediate refresh of global QuickBooks token"
    );
    const result = await module.exports.handleRefreshToken("");
    return result;
  }

  if (mode === "revoke") {
    logMessage(
      "INFO",
      "⚠️ Revoking global QuickBooks tokens (requires re-auth)"
    );
    await db.collection(QB_TOKEN_COLLECTION).updateOne(
      { key: GLOBAL_TOKEN_KEY },
      {
        $unset: {
          accessToken: "",
          access_token: "",
          refreshToken: "",
          refresh_token: "",
          idToken: "",
          tokenType: "",
        },
        $set: { updatedAt: new Date() },
      }
    );
    return { success: true, mode };
  }

  // Default: expire access token to force refresh on next use
  logMessage(
    "INFO",
    "ℹ️ Expiring global QuickBooks access token to force refresh"
  );
  await db.collection(QB_TOKEN_COLLECTION).updateOne(
    { key: GLOBAL_TOKEN_KEY },
    {
      $set: {
        createdAt: new Date(0),
        expiresIn: 0,
        updatedAt: new Date(),
      },
    }
  );
  return { success: true, mode: "expire" };
}

function computeExpiresAt(createdAt, expiresInSec) {
  try {
    if (!createdAt || !expiresInSec) {
      return 0;
    }

    const base = new Date(createdAt).getTime();
    return base + Number(expiresInSec) * 1000;
  } catch {
    return 0;
  }
}

async function ensureGlobalTokenFresh(db) {
  const tokenDoc = await getGlobalTokenDoc(db);
  if (!tokenDoc) {
    return null;
  }

  logMessage("DEBUG", "🐛 Global QuickBooks token document", {
    tokenDoc,
  });

  if (!tokenDoc.accessToken || !tokenDoc.refreshToken) {
    logMessage("WARN", "⚠️ Global QuickBooks token is missing fields");
    return null;
  }

  const now = Date.now();
  const expiresAt = computeExpiresAt(tokenDoc.createdAt, tokenDoc.expiresIn);
  logMessage("DEBUG", "🐛 Global QuickBooks token expiration check", {
    expiresAt,
  });

  if (expiresAt && now < expiresAt - 30_000) {
    // not expired (30s buffer)
    logMessage("DEBUG", "🐛 Global QuickBooks token still valid (buffered)", {
      expiresAt,
    });

    return tokenDoc;
  }

  // Refresh using stored refresh token
  if (!tokenDoc.refreshToken && !tokenDoc.refresh_token) {
    logMessage(
      "DEBUG",
      "🐛 Global QuickBooks token needs refresh (no refresh token)"
    );
    return null;
  }

  const refreshValue = tokenDoc.refreshToken || tokenDoc.refresh_token;

  logMessage(
    "INFO",
    "🔄 Refreshing global QuickBooks token using refresh token"
  );

  const oauthClient = await getOAuthClient();
  await oauthClient.refreshUsingToken(refreshValue);
  const saved = await upsertGlobalToken(db, oauthClient.token);

  logMessage("INFO", "✅ Global QuickBooks token refreshed and saved");
  return saved;
}

async function ensureQuickBooksCreds() {
  const now = Date.now();
  // Use direct env vars for local dev if present
  if (
    process.env.QUICKBOOKS_CLIENT_ID &&
    process.env.QUICKBOOKS_CLIENT_SECRET
  ) {
    cachedQBClientId = process.env.QUICKBOOKS_CLIENT_ID;
    cachedQBClientSecret = process.env.QUICKBOOKS_CLIENT_SECRET;
    credsLoadedAt = now;
    logMessage(
      "INFO",
      "ℹ️ Using QuickBooks credentials from environment (dev/local)"
    );
    return;
  }

  if (
    cachedQBClientId &&
    cachedQBClientSecret &&
    now - credsLoadedAt < CREDS_TTL
  ) {
    return;
  }

  const idSecretName = process.env.QUICKBOOKS_CLIENT_ID_SECRET_NAME;
  const keySecretName =
    process.env.QUICKBOOKS_CLIENT_KEY_SECRET_NAME ||
    process.env.QUICKBOOKS_CLIENT_SECRET_SECRET_NAME;

  const id = await getSecretStringFlexible(
    idSecretName,
    ["QUICKBOOKS_CLIENT_ID", "clientId", "CLIENT_ID", "id"],
    CREDS_TTL
  );
  const secret = await getSecretStringFlexible(
    keySecretName,
    [
      "QUICKBOOKS_CLIENT_SECRET",
      "clientSecret",
      "CLIENT_SECRET",
      "secret",
      "key",
    ],
    CREDS_TTL
  );

  cachedQBClientId = id || cachedQBClientId;
  cachedQBClientSecret = secret || cachedQBClientSecret;
  credsLoadedAt = now;

  logMessage(
    "INFO",
    "🔐 Loaded QuickBooks client credentials from Secrets Manager",
    {
      idSecretName,
      keySecretName,
      hasId: !!cachedQBClientId,
      hasSecret: !!cachedQBClientSecret,
    }
  );
}

// Determines if TaxCode should be bypassed based on env or deal flags
function shouldBypassTaxCode(deal) {
  const envVal = (process.env.QUICKBOOKS_BYPASS_TAX_CODE || "")
    .toString()
    .trim()
    .toLowerCase();
  const envBypass = envVal === "true" || envVal === "1" || envVal === "yes";
  const dealBypass = !!(
    deal &&
    (deal.bypassTaxCode === true ||
      deal.skipTaxCode === true ||
      deal.taxExempt === true)
  );
  return envBypass || dealBypass;
}

async function getOAuthClient() {
  await ensureQuickBooksCreds();

  if (!cachedQBClientId || !cachedQBClientSecret) {
    throw new Error("Missing QuickBooks client credentials");
  }

  // Recreate client if missing or credentials/env/redirect changed (supports runtime rotation)
  const credsKey = `${cachedQBClientId}:${cachedQBClientSecret}:${process.env.QUICKBOOKS_ENVIRONMENT}:${process.env.QUICKBOOKS_REDIRECT_URI || ""}`;
  if (!cachedOAuthClient || cachedOAuthClient.__credsKey !== credsKey) {
    cachedOAuthClient = new OAuthClient({
      clientId: cachedQBClientId,
      clientSecret: cachedQBClientSecret,
      environment: process.env.QUICKBOOKS_ENVIRONMENT,
      redirectUri: process.env.QUICKBOOKS_REDIRECT_URI,
    });
    cachedOAuthClient.__credsKey = credsKey;

    logMessage("DEBUG", "🐛 Created OAuthClient for QuickBooks (refreshed)", {
      environment: process.env.QUICKBOOKS_ENVIRONMENT,
      hasRedirect: !!process.env.QUICKBOOKS_REDIRECT_URI,
    });
  }

  return cachedOAuthClient;
}

/**
 * Helper to create a QuickBooks instance
 * @param {string} realmId - QuickBooks realm ID
 * @param {string} accessToken - QuickBooks access token
 * @param {string} [refreshToken] - QuickBooks refresh token (optional)
 * @returns {QuickBooks} Configured QuickBooks instance
 */
function getQBOInstance(realmId, accessToken, refreshToken) {
  return new QuickBooks(
    cachedQBClientId || process.env.QUICKBOOKS_CLIENT_ID,
    cachedQBClientSecret || process.env.QUICKBOOKS_CLIENT_SECRET,
    accessToken,
    false,
    realmId,
    process.env.QUICKBOOKS_ENVIRONMENT === "sandbox",
    false,
    null,
    "2.0",
    refreshToken
  );
}

/**
 * Extracts useful fields from a QuickBooks error object for logging/handling.
 */
function parseQboError(err) {
  const fault = err?.Fault || err?.fault;
  const first = fault?.Error?.[0] || fault?.error?.[0] || err;

  return {
    type: fault?.type,
    code: first?.code || first?.Code,
    message: first?.Message || first?.message || err?.message,
    detail: first?.Detail || first?.detail,
    element: first?.element || first?.Field || undefined,
    raw: err,
  };
}

// Helper: format Date to YYYY-MM-DD (UTC)
function formatDateYYYYMMDD(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (isNaN(d.getTime())) return undefined;
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// Helper: find Term ID by name (e.g., "Net 15")
async function getTermIdByName(qbo, name) {
  // try SDK direct if available
  if (typeof qbo.findTerms === "function") {
    const list = await new Promise((resolve, reject) => {
      qbo.findTerms({}, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
    const terms = list?.QueryResponse?.Term || [];
    const found = terms.find((t) => t?.Name === name && t?.Active !== false);
    return found ? String(found.Id) : null;
  }

  // fallback to query
  if (typeof qbo.query === "function") {
    const query = `SELECT Id, Name, Active FROM Term WHERE Name = '${name}'`;
    const res = await new Promise((resolve, reject) => {
      qbo.query(query, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
    const terms = res?.QueryResponse?.Term || [];
    const found = terms.find((t) => t?.Name === name && t?.Active !== false);
    return found ? String(found.Id) : null;
  }

  return null;
}

/**
 * Find a preferred TaxCode ID (e.g., GST/HST) for the company. Tries env QUICKBOOKS_TAX_CODE_NAMES
 * as a comma-separated list of names to match first. Falls back to searching for common Canadian
 * names like HST, GST/HST, GST.
 */
async function getPreferredTaxCodeId(qbo) {
  const now = Date.now();
  if (cachedTaxCodeId && now - taxCodeCachedAt < TAXCODE_TTL) {
    return cachedTaxCodeId;
  }

  // Allow explicit override without any API call
  if (process.env.QUICKBOOKS_TAX_CODE_ID) {
    cachedTaxCodeId = String(process.env.QUICKBOOKS_TAX_CODE_ID);
    taxCodeCachedAt = now;
    return cachedTaxCodeId;
  }

  const preferred = (process.env.QUICKBOOKS_TAX_CODE_NAMES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const listTaxCodes = () =>
    new Promise((resolve, reject) => {
      qbo.findTaxCodes({}, (err, data) => {
        if (err) return reject(err);
        const arr = data?.QueryResponse?.TaxCode || [];
        resolve(arr);
      });
    });

  try {
    // List and filter in memory using findTaxCodes only
    const all = await listTaxCodes();
    const active = all.filter((t) => t?.Active !== false);

    if (preferred.length > 0) {
      const foundPref = active.find((t) => preferred.includes(t?.Name));
      if (foundPref) {
        cachedTaxCodeId = String(foundPref.Id);
        taxCodeCachedAt = now;
        return cachedTaxCodeId;
      }
    }

    // Try to pick common Canadian codes
    const candidates = ["HST ON", "HST", "GST/HST", "GST", "TAX", "QST", "PST"];
    const found = active.find((t) => candidates.includes(t?.Name));
    if (found) {
      cachedTaxCodeId = String(found.Id);
      taxCodeCachedAt = now;
      return cachedTaxCodeId;
    }

    // If none matched but we have any, pick the first active one
    if (active.length > 0) {
      cachedTaxCodeId = String(active[0].Id);
      taxCodeCachedAt = now;
      return cachedTaxCodeId;
    }

    // If still nothing, throw instructive error
    throw new Error(
      "No suitable TaxCode found. Set env QUICKBOOKS_TAX_CODE_NAMES to a valid TaxCode name (e.g., 'HST ON')."
    );
  } catch (e) {
    const info = parseQboError(e);
    logMessage("ERROR", "❌ Failed to retrieve TaxCode from QuickBooks", {
      message: info.message,
      detail: info.detail,
    });
    throw e;
  }
}

/**
 * Generates the QuickBooks OAuth authorization URI for a user
 * @param {string} userId - The user ID
 * @returns {string} The authorization URI
 */
async function getAuthUri(userId) {
  logMessage(
    "DEBUG",
    "🐛 Generating auth URI (single-company mode). user:",
    userId
  );

  const oauthClient = await getOAuthClient();
  const authUri = oauthClient.authorizeUri({
    scope: [
      OAuthClient.scopes.Accounting,
      OAuthClient.scopes.Payment,
      OAuthClient.scopes.OpenId,
    ],
    state: userId,
  });

  logMessage("DEBUG", "🐛 Generated auth URI:", authUri);
  return authUri;
}

/**
 * Checks if a user's QuickBooks connection is valid and refreshes token if needed
 * @param {string} userId - The user ID
 * @returns {Promise<{connected: boolean, authUrl: string}>}
 */
async function checkConnection(userId) {
  const db = getDB();
  let authUrl = await getAuthUri(userId);

  logMessage("INFO", "🔄 Checking QuickBooks connection (single-company mode)");

  try {
    const fresh = await ensureGlobalTokenFresh(db);

    if (!fresh) {
      logMessage("INFO", "ℹ️ No global QuickBooks token present yet.");
      return { connected: false, authUrl };
    }

    logMessage("INFO", "✅ Global QuickBooks token is available");
    return { connected: true, authUrl };
  } catch (error) {
    logMessage("ERROR", "❌ checkConnection (global) error:", error);
    return { connected: false, authUrl };
  }
}

/**
 * Handles the QuickBooks OAuth callback and saves the token to MongoDB
 * @param {string} parseRedirectUrl - The redirect URL from OAuth
 * @param {string} code - The OAuth code
 * @param {string} state - The user ID/state
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function handleCallback(parseRedirectUrl, code, state) {
  const db = getDB();

  try {
    logMessage(
      "INFO",
      "🔄 Handling QuickBooks OAuth callback for user:",
      state
    );
    logMessage("INFO", "🔄 Redirect URL:", parseRedirectUrl);
    logMessage("DEBUG", "🐛 OAuth callback parameters:", {
      code,
      state,
      parseRedirectUrl,
    });

    let oauthClient = await getOAuthClient();
    try {
      await oauthClient.createToken(parseRedirectUrl);
    } catch (e) {
      if (isInvalidClientError(e)) {
        // Secrets might have rotated; clear caches and retry once
        logMessage(
          "WARN",
          "⚠️ invalid_client during createToken — reloading credentials and retrying once"
        );
        resetQbCredsCache();
        oauthClient = await getOAuthClient();
        await oauthClient.createToken(parseRedirectUrl);
      } else {
        throw e;
      }
    }

    logMessage("DEBUG", "🐛 OAuth client after createToken:", {
      hasToken: !!oauthClient.token,
      tokenKeys: oauthClient.token ? Object.keys(oauthClient.token) : [],
    });

    if (!oauthClient.token) {
      logMessage("ERROR", "❌ OAuth token is null or undefined");
      logMessage("DEBUG", "createToken failed - no token created");
      return { success: false, error: "Failed to create OAuth token" };
    }

    // Enhanced logging: pretty print token details, mask sensitive fields
    const token = oauthClient.token || {};
    const createdAt = token.createdAt
      ? new Date(token.createdAt).toISOString()
      : "N/A";

    let expiresAt = "N/A";
    if (token.expires_in && !isNaN(token.expires_in)) {
      try {
        expiresAt = new Date(
          Date.now() + Number(token.expires_in) * 1000
        ).toISOString();
      } catch {
        expiresAt = "N/A";
      }
    }

    let refreshExpiresAt = "N/A";
    if (
      token.x_refresh_token_expires_in &&
      !isNaN(token.x_refresh_token_expires_in)
    ) {
      try {
        refreshExpiresAt = new Date(
          Date.now() + Number(token.x_refresh_token_expires_in) * 1000
        ).toISOString();
      } catch {
        refreshExpiresAt = "N/A";
      }
    }

    logMessage(
      "INFO",
      "✅ OAuth token created successfully at:",
      createdAt,
      ",for user:",
      state,
      ",expires at:",
      expiresAt,
      ",refresh token expires at:",
      refreshExpiresAt
    );

    // Save as a single shared token for the company
    const result = await upsertGlobalToken(db, oauthClient.token);
    logMessage("INFO", "✅ Saved global QuickBooks token", {
      hasAccessToken: !!result.accessToken,
      hasRefreshToken: !!result.refreshToken,
      realmId: result.realmId,
    });
    return { success: true };
  } catch (error) {
    logMessage("ERROR", "❌ OAuth callback error:", error);

    if (
      error.code === 13 ||
      (error.errmsg && error.errmsg.includes("requires authentication"))
    ) {
      logMessage(
        "ERROR",
        "❌ MongoDB authentication error. Check your connection string and credentials."
      );
    }
    return { success: false, error: "Failed to connect to QuickBooks" };
  }
}

/**
 * Refreshes the QuickBooks OAuth token for a user
 * @param {string} userId - The user ID
 * @returns {Promise<{success: boolean, status?: number, error?: string}>}
 */
async function handleRefreshToken(userId) {
  const db = getDB();
  try {
    // explicitly consume parameter to satisfy no-unused-vars without changing API
    void userId;
    logMessage("INFO", "🔄 Refreshing global QuickBooks token");

    const tokenDoc = await getGlobalTokenDoc(db);
    if (!tokenDoc || (!tokenDoc.refreshToken && !tokenDoc.refresh_token)) {
      return {
        success: false,
        status: 404,
        error: "❌ No global refresh token found",
      };
    }

    let oauthClient = await getOAuthClient();
    try {
      await oauthClient.refreshUsingToken(
        tokenDoc.refreshToken || tokenDoc.refresh_token
      );
    } catch (e) {
      if (isInvalidClientError(e)) {
        logMessage(
          "WARN",
          "⚠️ invalid_client during refreshUsingToken — reloading credentials and retrying once"
        );
        resetQbCredsCache();
        oauthClient = await getOAuthClient();
        await oauthClient.refreshUsingToken(
          tokenDoc.refreshToken || tokenDoc.refresh_token
        );
      } else {
        throw e;
      }
    }

    await upsertGlobalToken(db, oauthClient.token);

    logMessage("INFO", `✅ Refreshed global QuickBooks token`);
    return { success: true };
  } catch (error) {
    logMessage("ERROR", "❌ Global token refresh error:", error);
    return {
      success: false,
      status: 500,
      error: error.message || "Failed to refresh token",
    };
  }
}

/**
 * Retrieves the active shared QuickBooks tokens, refreshing if necessary.
 * @returns {Promise<{accessToken:string, refreshToken:string, realmId:string}>}
 */
async function getGlobalTokens() {
  const db = getDB();
  const fresh = await ensureGlobalTokenFresh(db);

  if (!fresh) {
    throw new Error(
      "No global QuickBooks token available. Admin must authorize first."
    );
  }

  return {
    accessToken: fresh.accessToken || fresh.access_token,
    refreshToken: fresh.refreshToken || fresh.refresh_token,
    realmId: fresh.realmId || fresh.realm_id,
  };
}

/**
 * Finds or creates a QuickBooks customer based on HubSpot contact info
 * @param {string} realmId - QuickBooks realm ID
 * @param {string} accessToken - QuickBooks access token
 * @param {Object} contact - HubSpot contact object
 * @param {string} refreshToken - QuickBooks refresh token
 * @returns {Promise<string>} The QuickBooks customer ID
 */
async function getOrCreateCustomer(
  realmId,
  accessToken,
  contact,
  refreshToken
) {
  await ensureQuickBooksCreds();
  // If tokens not supplied, use the shared company tokens
  if (!realmId || !accessToken) {
    const shared = await getGlobalTokens();
    realmId = realmId || shared.realmId;
    accessToken = accessToken || shared.accessToken;
    refreshToken = refreshToken || shared.refreshToken;
  }
  logMessage(
    "DEBUG",
    "🐛 Creating QuickBooks instance for customer lookup/creation",
    {
      realmId,
      hasAccessToken: !!accessToken,
      hasRefreshToken: !!refreshToken,
      contactEmail: contact.email,
    }
  );

  const qbo = getQBOInstance(realmId, accessToken, refreshToken);

  const email = contact.email;
  let customerResponse;

  if (typeof qbo.findCustomers === "function") {
    customerResponse = await handleQBOFindCustomers(qbo, contact);
  } else if (typeof qbo.query === "function") {
    customerResponse = await handleQBOQuery();
  } else {
    throw new Error("❌ No supported method to find customers on qbo instance");
  }

  let customerId, customerDataToSave;
  const db = getDB();

  if (customerResponse.QueryResponse.Customer?.length > 0) {
    const customerObj = customerResponse.QueryResponse.Customer[0];
    customerId = customerObj.Id;
    customerDataToSave = customerObj;
  } else {
    // Create customer
    const customerData = {
      GivenName: contact.firstname || "Unknown",
      FamilyName: contact.lastname || "Customer",
      PrimaryEmailAddr: { Address: email },
    };

    const createCustomerResponse = await new Promise((resolve, reject) => {
      qbo.createCustomer(customerData, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });

    customerId = createCustomerResponse.Id;
    customerDataToSave = createCustomerResponse;
  }

  if (!customerId) {
    throw new Error("❌ Failed to find or create customer in QuickBooks");
  }

  // Save customer to MongoDB (upsert by contact_id, matching unique index in db.js)
  try {
    // Ensure contact_id is present and set in both filter and document
    const customerDoc = toCamelCase(customerDataToSave);
    let contactId = customerDoc.contactId || customerDoc.Id || customerId;
    if (!contactId) {
      // Try to get from HubSpot contact if available
      contactId = contact.contact_id || contact.id || null;
    }

    if (!contactId) {
      throw new Error("Missing contact_id for MongoDB upsert");
    }

    customerDoc.contactId = contactId; // Always set contactId in document

    await db
      .collection(QB_HUBSPOT_CUSTOMER_COLLECTION)
      .updateOne(
        { contactId: contactId },
        { $set: customerDoc },
        { upsert: true }
      );
    logMessage(
      "INFO",
      `✅ Saved QuickBooks customer ${customerId} to MongoDB (contact_id: ${contactId})`
    );
  } catch (e) {
    logMessage(
      "ERROR",
      `❌ Failed to save QuickBooks customer ${customerId} to MongoDB:`,
      e.message
    );
    throw e;
  }

  return customerId;
}

async function handleQBOQuery(qbo, contact) {
  const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${contact.email}'`;
  return new Promise((resolve, reject) => {
    qbo.query(query, async (err, data) => {
      if (err) {
        const errorCode =
          err?.Fault?.Error?.[0]?.code || err?.fault?.error?.[0]?.code;
        if (errorCode === "3200") {
          logMessage(
            "WARN",
            "⚠️ QuickBooks token expired (code 3200), refreshing token..."
          );

          await module.exports.handleRefreshToken(
            contact.userId || contact.id || ""
          );

          return reject(new Error("Token refreshed, please retry request."));
        }

        logMessage(
          "ERROR",
          "❌ Error finding customer (query):",
          err?.fault?.error
        );

        return reject(err);
      }
      resolve(data);
    });
  });
}

async function handleQBOFindCustomers(qbo, contact) {
  return new Promise((resolve, reject) => {
    qbo.findCustomers(
      [{ field: "PrimaryEmailAddr", value: contact.email, operator: "=" }],
      async (err, data) => {
        if (err) {
          // Check for error code 3200 (token expired)
          const errorCode =
            err?.Fault?.Error?.[0]?.code || err?.fault?.error?.[0]?.code;
          if (errorCode === "3200") {
            logMessage(
              "WARN",
              "⚠️ QuickBooks token expired (code 3200), refreshing token..."
            );
            await module.exports.handleRefreshToken(
              contact.userId || contact.id || ""
            );
            return reject(new Error("Token refreshed, please retry request."));
          }
          logMessage("ERROR", "❌ Error finding customer:", err?.fault?.error);
          return reject(err);
        }
        resolve(data);
      }
    );
  });
}

/** * Retrieves a QuickBooks customer by email
 * @param {string} realmId - QuickBooks realm ID
 * @param {string} accessToken - QuickBooks access token
 * @param {string} email - Customer email address
 * @returns {Promise<Object>} - QuickBooks customer object
 */
async function getCustomerByEmail(realmId, accessToken, email) {
  await ensureQuickBooksCreds();
  const qbo = getQBOInstance(realmId, accessToken);

  const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;
  const response = await new Promise((resolve, reject) => {
    qbo.query(query, (err, data) => {
      if (err) return reject(err);
      resolve(data);
    });
  });

  if (!response.QueryResponse || !response.QueryResponse.Customer) {
    throw new Error(`❌ No customer found with email: ${email}`);
  }

  return response.QueryResponse.Customer[0];
}

/**
 * Creates a QuickBooks invoice for a customer and associates it with a HubSpot deal
 * @param {string} realmId - QuickBooks realm ID
 * @param {string} accessToken - QuickBooks access token
 * @param {string} refreshToken - QuickBooks refresh token
 * @param {string} customerId - QuickBooks customer ID
 * @param {Object} deal - HubSpot deal object (must have id and amount)
 * @returns {Promise<{invoiceNumber: string, invoiceUrl: string}>}
 */
async function createInvoice(
  realmId,
  accessToken,
  refreshToken,
  customerId,
  deal,
  customerEmail
) {
  await ensureQuickBooksCreds();
  // Use shared company tokens if not supplied
  if (!realmId || !accessToken) {
    const shared = await getGlobalTokens();
    realmId = realmId || shared.realmId;
    accessToken = accessToken || shared.accessToken;
    refreshToken = refreshToken || shared.refreshToken;
  }
  logMessage("DEBUG", "🐛 Creating QuickBooks instance for invoice creation", {
    realmId,
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    customerId,
    dealId: deal.id,
    dealAmount: deal.amount,
  });

  const qbo = getQBOInstance(realmId, accessToken, refreshToken);

  logMessage("DEBUG", "🔄 Creating QuickBooks invoice", {
    customerId,
    dealId: deal.id,
    amount: deal.amount,
  });
  logMessage("DEBUG", "📄 Invoice creation details:", { customerId, deal });

  let itemId = "1";
  try {
    itemId = await getFirstItemId(qbo);
  } catch (e) {
    logMessage(
      "ERROR",
      "❌ Could not fetch Item ID, using default '1'",
      e.message
    );

    throw e;
  }

  // Validate and normalize amount
  const amount = Number.isFinite(Number(deal.amount))
    ? parseFloat(deal.amount)
    : NaN;
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(
      `Invalid deal amount for invoice. Received: "${deal.amount}"`
    );
  }

  const qty = 1;
  const unitPrice = amount; // Keep simple: one line with qty 1 at full amount

  // Attempt to include a GST/HST TaxCode if company requires it
  let taxCodeId = null;
  const bypassTax = shouldBypassTaxCode(deal);
  if (bypassTax) {
    logMessage("INFO", "ℹ️ Bypassing TaxCode for invoice per configuration", {
      dealId: deal.id,
    });
  } else {
    try {
      taxCodeId = await getPreferredTaxCodeId(qbo);
      logMessage("DEBUG", "🐛 Using TaxCodeId for invoice", taxCodeId);
    } catch (e) {
      // If TaxCode retrieval fails, proceed without it; QBO may still accept for some regions
      logMessage(
        "WARN",
        "⚠️ Could not determine TaxCodeId automatically; proceeding without TaxCodeRef",
        e?.message || e
      );
    }
  }

  // Normalize HubSpot deal job_completion_date -> ServiceDate (YYYY-MM-DD)
  const serviceDate = (() => {
    const raw = deal?.job_completion_date;
    if (!raw) return undefined;
    // HubSpot often stores datetimes as ms epoch strings; also support ISO/date strings
    let d;
    if (typeof raw === "number") {
      d = new Date(raw);
    } else if (/^\d{10,13}$/.test(String(raw))) {
      const ms = String(raw).length === 13 ? Number(raw) : Number(raw) * 1000;
      d = new Date(ms);
    } else {
      d = new Date(String(raw));
    }
    if (isNaN(d.getTime())) return undefined;
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(d.getUTCDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  })();

  // Terms: Prefer SalesTermRef for "Net 15"; fallback to DueDate = base + 15 days
  let salesTermRefId = null;
  let dueDateStr = undefined;
  try {
    salesTermRefId = await getTermIdByName(qbo, "Net 15");
  } catch (e) {
    logMessage(
      "WARN",
      "⚠️ Failed to lookup Terms (Net 15), will fallback",
      e?.message || e
    );
  }

  if (!salesTermRefId) {
    const base = serviceDate
      ? new Date(`${serviceDate}T00:00:00Z`)
      : new Date();
    base.setUTCDate(base.getUTCDate() + 15);
    dueDateStr = formatDateYYYYMMDD(base);
  }

  const description = (() => {
    const raw = deal?.description;
    if (raw == null) return undefined;
    const str = String(raw).trim();
    return str.length > 0 ? str : undefined;
  })();

  const invoiceData = {
    Line: [
      {
        Amount: qty * unitPrice,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: {
          ItemRef: { value: itemId },
          Qty: qty,
          UnitPrice: unitPrice,
          ...(serviceDate ? { ServiceDate: serviceDate } : {}),
          ...(taxCodeId ? { TaxCodeRef: { value: taxCodeId } } : {}),
        },
        ...(description ? { Description: description } : {}),
      },
    ],
    CustomerRef: { value: customerId },
    ...(customerEmail
      ? {
          BillEmail: { Address: String(customerEmail) },
        }
      : {}),
    ...(description ? { CustomerMemo: { value: description } } : {}),
    ...(salesTermRefId
      ? { SalesTermRef: { value: salesTermRefId } }
      : dueDateStr
        ? { DueDate: dueDateStr }
        : {}),
    ...(taxCodeId
      ? {
          TxnTaxDetail: {
            TxnTaxCodeRef: { value: taxCodeId },
          },
          GlobalTaxCalculation:
            process.env.QUICKBOOKS_TAX_CALCULATION || "TaxExcluded",
        }
      : {}),
  };

  logMessage("INFO", "Creating QuickBooks invoice with data:", invoiceData);

  const invoiceResponse = await new Promise((resolve, reject) => {
    qbo.createInvoice(invoiceData, (err, data) => {
      if (err) {
        const info = parseQboError(err);
        // Emit structured details to help diagnose ValidationFaults
        logMessage("ERROR", "❌ Error creating QuickBooks invoice", {
          type: info.type,
          code: info.code,
          message: info.message,
          detail: info.detail,
          element: info.element,
        });

        logMessage("DEBUG", "Invoice payload that failed", invoiceData);

        return reject(
          new Error(
            info.message || info.detail || "QuickBooks createInvoice failed"
          )
        );
      }
      resolve(data);
    });
  });

  const invoiceId = invoiceResponse.Id;
  const invoiceUrl = `${QUICKBOOKS_APP_URL ?? "https://sandbox.qbo.intuit.com/app/invoice"}?txnId=${invoiceId}`;
  return { invoiceNumber: invoiceId, invoiceUrl };
}

/**
 * Gets the first Item ID from QuickBooks account (used for invoice line)
 * @param {QuickBooks} qbo - QuickBooks instance
 * @returns {Promise<string>} The first Item ID
 */
async function getFirstItemId(qbo) {
  return new Promise((resolve, reject) => {
    qbo.findItems({}, (err, items) => {
      if (err) {
        return reject(err);
      }

      if (
        items &&
        items.QueryResponse &&
        items.QueryResponse.Item &&
        items.QueryResponse.Item.length > 0
      ) {
        resolve(items.QueryResponse.Item[0].Id);
      } else {
        reject(new Error("No items found in QuickBooks account."));
      }
    });
  });
}

/**
 * Retrieves all invoices for a QuickBooks customer, optionally filtered by dealId (stored in Memo field)
 * @param {string} realmId - QuickBooks realm ID
 * @param {string} accessToken - QuickBooks access token
 * @param {string} refreshToken - QuickBooks refresh token
 * @param {string} customerId - QuickBooks customer ID
 * @param {string} [dealId] - Optional, filter invoices by dealId in Memo field
 * @returns {Promise<Array>} Array of invoice objects
 */
async function getInvoicesForCustomer(
  realmId,
  accessToken,
  refreshToken,
  customerId,
  dealId
) {
  // Create QuickBooks instance
  await ensureQuickBooksCreds();

  if (!realmId || !accessToken) {
    const shared = await getGlobalTokens();
    realmId = realmId || shared.realmId;
    accessToken = accessToken || shared.accessToken;
    refreshToken = refreshToken || shared.refreshToken;
  }

  const qbo = getQBOInstance(realmId, accessToken, refreshToken);

  const query = `SELECT * FROM Invoice WHERE CustomerRef = '${customerId}'`;
  let invoices = [];

  try {
    const response = await new Promise((resolve, reject) => {
      qbo.query(query, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });

    invoices = response.QueryResponse.Invoice || [];

    if (dealId) {
      invoices = invoices.filter(
        (inv) => inv.Memo && inv.Memo.includes(dealId)
      );
    }
  } catch (e) {
    logMessage("ERROR", "❌ Error fetching invoices for customer:", e);
    throw e;
  }

  return invoices;
}

/**
 * Verifies if a specific invoice is still valid (exists and not deleted) in QuickBooks
 * @param {string} realmId - QuickBooks realm ID
 * @param {string} accessToken - QuickBooks access token
 * @param {string} refreshToken - QuickBooks refresh token
 * @param {string} invoiceId - QuickBooks invoice ID
 * @returns {Promise<boolean>} True if invoice is valid, false otherwise
 */
async function isInvoiceValidInQuickBooks(
  realmId,
  accessToken,
  refreshToken,
  invoiceId
) {
  await ensureQuickBooksCreds();

  if (!realmId || !accessToken) {
    const shared = await getGlobalTokens();
    realmId = realmId || shared.realmId;
    accessToken = accessToken || shared.accessToken;
    refreshToken = refreshToken || shared.refreshToken;
  }

  const qbo = getQBOInstance(realmId, accessToken, refreshToken);

  try {
    const response = await new Promise((resolve, reject) => {
      qbo.getInvoice(invoiceId, (err, data) => {
        if (err) {
          // If error is not found, consider invoice invalid
          if (
            err.Fault &&
            err.Fault.Error &&
            err.Fault.Error[0].Message &&
            err.Fault.Error[0].Message.includes("not found")
          ) {
            return resolve(false);
          }
          return reject(err);
        }
        // If invoice is found and not marked as deleted
        if (data && data.Id && (!data.Status || data.Status !== "Deleted")) {
          return resolve(true);
        }
        return resolve(false);
      });
    });
    return response;
  } catch (e) {
    logMessage("ERROR", "❌ Error verifying invoice in QuickBooks:", e);
    return false;
  }
}

/**
 * Verifies a list of invoice IDs in QuickBooks using a single batch query
 * @param {string} realmId - QuickBooks realm ID
 * @param {string} accessToken - QuickBooks access token
 * @param {string} refreshToken - QuickBooks refresh token
 * @param {Array<string>} invoiceIds - Array of QuickBooks invoice IDs
 * @returns {Promise<Object>} Object with invoiceId as key and validity boolean as value
 */
async function verifyInvoicesInQuickBooks(
  realmId,
  accessToken,
  refreshToken,
  invoiceIds
) {
  await ensureQuickBooksCreds();
  if (!realmId || !accessToken) {
    const shared = await getGlobalTokens();
    realmId = realmId || shared.realmId;
    accessToken = accessToken || shared.accessToken;
    refreshToken = refreshToken || shared.refreshToken;
  }
  const qbo = getQBOInstance(realmId, accessToken, refreshToken);
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return {};
  }

  logMessage(
    "DEBUG",
    "🔎 Verifying invoices in QuickBooks for realmId:",
    realmId,
    "with invoiceIds:",
    invoiceIds
  );

  try {
    let response;

    if (typeof qbo.query === "function") {
      const query = `SELECT * FROM Invoice WHERE Id IN (${invoiceIds.map((id) => `'${id}'`).join(",")})`;
      response = await new Promise((resolve, reject) => {
        qbo.query(query, (err, data) => {
          if (err) {
            const errorMsg = `QuickBooks query error: ${err?.Fault?.Error?.[0]?.Message || err?.message || JSON.stringify(err)}`;
            return reject(new Error(errorMsg));
          }
          resolve(data);
        });
      });
    } else if (typeof qbo.findInvoices === "function") {
      response = await new Promise((resolve, reject) => {
        qbo.findInvoices({}, (err, data) => {
          if (err) {
            const errorMsg = `QuickBooks findInvoices error: ${err?.Fault?.Error?.[0]?.Message || err?.message || JSON.stringify(err)}`;
            return reject(new Error(errorMsg));
          }
          resolve(data);
        });
      });
    } else {
      throw new Error("No supported method to query invoices on qbo instance");
    }

    // Map returned invoices by ID
    const invoices = response.QueryResponse?.Invoice || [];
    const foundInvoices = invoices.reduce((acc, inv) => {
      acc[inv.Id] = inv && (!inv.Status || inv.Status !== "Deleted");
      return acc;
    }, {});

    // Build result for all requested invoiceIds
    const result = {};

    for (const id of invoiceIds) {
      result[id] = !!foundInvoices[id];
    }

    return result;
  } catch (e) {
    logMessage("ERROR", "❌ Error verifying invoices in QuickBooks:", e);
    // If error, mark all as valid since we can't determine their status
    logMessage("DEBUG", "⚠️ Returning all invoiceIds as valid due to error");
    return invoiceIds.reduce((acc, id) => {
      acc[id] = true;
      return acc;
    }, {});
  }
}

module.exports = {
  getAuthUri,
  handleCallback,
  handleRefreshToken,
  getOrCreateCustomer,
  createInvoice,
  checkConnection,
  getInvoicesForCustomer,
  getCustomerByEmail,
  getQBOInstance,
  isInvoiceValidInQuickBooks,
  verifyInvoicesInQuickBooks,
  getGlobalTokens,
  invalidateGlobalToken,
};
