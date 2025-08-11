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
const CREDS_TTL = 10 * 60 * 1000; // 10 minutes

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

  const id = await getSecretStringFlexible(idSecretName, [
    "QUICKBOOKS_CLIENT_ID",
    "clientId",
    "CLIENT_ID",
    "id",
  ]);
  const secret = await getSecretStringFlexible(keySecretName, [
    "QUICKBOOKS_CLIENT_SECRET",
    "clientSecret",
    "CLIENT_SECRET",
    "secret",
    "key",
  ]);

  cachedQBClientId = id || cachedQBClientId;
  cachedQBClientSecret = secret || cachedQBClientSecret;
  credsLoadedAt = now;
}

async function getOAuthClient() {
  await ensureQuickBooksCreds();

  if (!cachedQBClientId || !cachedQBClientSecret) {
    throw new Error("Missing QuickBooks client credentials");
  }

  // Recreate client if missing or credentials may have rotated
  if (!cachedOAuthClient) {
    cachedOAuthClient = new OAuthClient({
      clientId: cachedQBClientId,
      clientSecret: cachedQBClientSecret,
      environment: process.env.QUICKBOOKS_ENVIRONMENT,
      redirectUri: process.env.QUICKBOOKS_REDIRECT_URI,
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
 * Generates the QuickBooks OAuth authorization URI for a user
 * @param {string} userId - The user ID
 * @returns {string} The authorization URI
 */
async function getAuthUri(userId) {
  logMessage("DEBUG", "Generating auth URI for user:", userId);

  const oauthClient = await getOAuthClient();
  const authUri = oauthClient.authorizeUri({
    scope: [
      OAuthClient.scopes.Accounting,
      OAuthClient.scopes.Payment,
      OAuthClient.scopes.OpenId,
    ],
    state: userId,
  });

  logMessage("DEBUG", "Generated auth URI:", authUri);
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

  logMessage("INFO", "🔄 Checking QuickBooks connection for user:", userId);
  logMessage("DEBUG", "Auth URL generated:", authUrl);

  try {
    const tokenDoc = await db
      .collection(QB_TOKEN_COLLECTION)
      .findOne({ userId });

    logMessage("DEBUG", "Token document found:", tokenDoc ? "Yes" : "No");
    if (tokenDoc) {
      logMessage("DEBUG", "Token details:", {
        hasAccessToken: !!tokenDoc.accessToken,
        hasRefreshToken: !!tokenDoc.refreshToken,
        createdAt: tokenDoc.createdAt,
        expiresIn: tokenDoc.expiresIn,
      });
    }

    if (!tokenDoc) {
      logMessage("INFO", "🔄 No token found for user:", userId);
      return { connected: false, authUrl };
    }

    const now = Date.now();
    let expiresAt = 0;
    if (tokenDoc.createdAt && tokenDoc.expiresIn) {
      expiresAt =
        new Date(tokenDoc.createdAt).getTime() +
        Number(tokenDoc.expiresIn) * 1000;
    }

    logMessage("DEBUG", "Token expiration check:", {
      now: new Date(now).toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "N/A",
      isExpired: expiresAt && now > expiresAt,
    });

    if (expiresAt && now > expiresAt) {
      logMessage("INFO", "🔄 Token expired for user:", userId);
      logMessage("DEBUG", "Attempting to refresh token for user:", userId);
      const refreshResult = await module.exports.handleRefreshToken(userId);

      logMessage("DEBUG", "Refresh result:", refreshResult);
      if (!refreshResult.success) {
        logMessage("ERROR", "❌ Failed to refresh token for user:", userId);
        return { connected: false, authUrl };
      }
    }

    logMessage("INFO", "✅ Token is valid for user:", userId);
    return { connected: true, authUrl };
  } catch (error) {
    logMessage("ERROR", "❌ checkConnection error:", error);
    logMessage("DEBUG", "checkConnection error details:", error);
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
    logMessage("DEBUG", "OAuth callback parameters:", {
      code,
      state,
      parseRedirectUrl,
    });

    const oauthClient = await getOAuthClient();
    await oauthClient.createToken(parseRedirectUrl);
    logMessage("DEBUG", "OAuth client after createToken:", {
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

    const result = await db.collection(QB_TOKEN_COLLECTION).updateOne(
      { userId: state },
      {
        $set: {
          ...toCamelCase(oauthClient.token),
        },
      },
      { upsert: true }
    );

    logMessage("INFO", "✅ MongoDB update result:", result);
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
    logMessage("INFO", "🔄 Refreshing QuickBooks token for user:", userId);

    const tokenDoc = await db
      .collection(QB_TOKEN_COLLECTION)
      .findOne({ userId });

    if (!tokenDoc || !tokenDoc.refresh_token) {
      return {
        success: false,
        status: 404,
        error: "❌ No refresh token found for this user",
      };
    }

    const oauthClient = await getOAuthClient();
    await oauthClient.refreshUsingToken(tokenDoc.refresh_token);
    logMessage("INFO", "🔄 Refreshing token for user:", userId);

    await db.collection(QB_TOKEN_COLLECTION).updateOne(
      { userId },
      {
        $set: {
          ...tokenDoc,
          accessToken: oauthClient.token.access_token,
          refreshToken: oauthClient.token.refresh_token,
          expiresIn: oauthClient.token.expires_in,
          xRefreshTokenExpiresIn: oauthClient.token.x_refresh_token_expires_in,
          latency: oauthClient.token.latency,
          updatedAt: new Date(),
        },
      }
    );

    logMessage("INFO", `✅ Refreshed token for user: ${userId}`);

    return { success: true };
  } catch (error) {
    logMessage("ERROR", "❌ Token refresh error:", error);
    return {
      success: false,
      status: 500,
      error: error.message || "Failed to refresh token",
    };
  }
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
  logMessage(
    "DEBUG",
    "Creating QuickBooks instance for customer lookup/creation",
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
            "QuickBooks token expired (code 3200), refreshing token..."
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
              "QuickBooks token expired (code 3200), refreshing token..."
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
  deal
) {
  await ensureQuickBooksCreds();
  logMessage("DEBUG", "Creating QuickBooks instance for invoice creation", {
    realmId,
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    customerId,
    dealId: deal.id,
    dealAmount: deal.amount,
  });

  const qbo = getQBOInstance(realmId, accessToken, refreshToken);

  console.log(
    "Creating QuickBooks invoice for customer:",
    customerId,
    "with deal amount:",
    deal.amount,
    "and deal ID:",
    deal.id
  );
  logMessage("DEBUG", "Invoice creation details:", { customerId, deal });

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

  const invoiceData = {
    Line: [
      {
        Amount: parseFloat(deal.amount) || 0,
        DetailType: "SalesItemLineDetail",
        SalesItemLineDetail: { ItemRef: { value: itemId } },
      },
    ],
    CustomerRef: { value: customerId },
  };

  console.log("Creating QuickBooks invoice with data:", invoiceData);

  const invoiceResponse = await new Promise((resolve, reject) => {
    qbo.createInvoice(invoiceData, (err, data) => {
      if (err) {
        logMessage("ERROR", "❌ Error creating QuickBooks invoice:", err);
        return reject(err);
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
  const qbo = getQBOInstance(realmId, accessToken, refreshToken);
  if (!Array.isArray(invoiceIds) || invoiceIds.length === 0) {
    return {};
  }

  logMessage(
    "DEBUG",
    "Verifying invoices in QuickBooks for realmId:",
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
    logMessage("DEBUG", "Returning all invoiceIds as valid due to error");
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
};
