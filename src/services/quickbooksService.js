const OAuthClient = require("intuit-oauth");
const QuickBooks = require("node-quickbooks");
const { getDB } = require("../config/db");
const { QB_TOKEN_COLLECTION } = require("../models/constants");
const { QUICKBOOKS_APP_URL } = require("../models/urls");
const { logMessage } = require("../common/logger");

// Enable debugging
const DEBUG =
  process.env.DEBUG === "true" || process.env.NODE_ENV === "development";

const oauthClient = new OAuthClient({
  clientId: process.env.QUICKBOOKS_CLIENT_ID,
  clientSecret: process.env.QUICKBOOKS_CLIENT_SECRET,
  environment: process.env.QUICKBOOKS_ENVIRONMENT,
  redirectUri: process.env.QUICKBOOKS_REDIRECT_URI,
  logging: DEBUG, // Enable OAuth client logging when debugging
});

// Debug helper function
function debugLog(message, ...args) {
  if (DEBUG) {
    console.log(`[DEBUG QB Service] ${message}`, ...args);
    logMessage("DEBUG", message, ...args);
  }
}

function getAuthUri(userId) {
  debugLog("Generating auth URI for user:", userId);
  const authUri = oauthClient.authorizeUri({
    scope: [
      OAuthClient.scopes.Accounting,
      OAuthClient.scopes.Payment,
      OAuthClient.scopes.OpenId,
    ],
    state: userId,
  });
  debugLog("Generated auth URI:", authUri);
  return authUri;
}

async function checkConnection(userId) {
  const db = getDB();
  let authUrl = getAuthUri(userId);
  logMessage("INFO", "🔄 Checking QuickBooks connection for user:", userId);
  debugLog("Auth URL generated:", authUrl);

  try {
    const tokenDoc = await db
      .collection(QB_TOKEN_COLLECTION)
      .findOne({ userId });

    debugLog("Token document found:", tokenDoc ? "Yes" : "No");
    if (tokenDoc) {
      debugLog("Token details:", {
        hasAccessToken: !!tokenDoc.access_token,
        hasRefreshToken: !!tokenDoc.refresh_token,
        createdAt: tokenDoc.createdAt,
        expiresIn: tokenDoc.expires_in,
      });
    }

    if (!tokenDoc) {
      logMessage("INFO", "🔄 No token found for user:", userId);
      return { connected: false, authUrl };
    }

    const now = Date.now();
    let expiresAt = 0;
    if (tokenDoc.createdAt && tokenDoc.expires_in) {
      expiresAt =
        new Date(tokenDoc.createdAt).getTime() +
        Number(tokenDoc.expires_in) * 1000;
    }

    debugLog("Token expiration check:", {
      now: new Date(now).toISOString(),
      expiresAt: expiresAt ? new Date(expiresAt).toISOString() : "N/A",
      isExpired: expiresAt && now > expiresAt,
    });

    if (expiresAt && now > expiresAt) {
      logMessage("INFO", "🔄 Token expired for user:", userId);
      debugLog("Attempting to refresh token for user:", userId);
      const refreshResult = await module.exports.handleRefreshToken(userId);
      debugLog("Refresh result:", refreshResult);
      if (!refreshResult.success) {
        logMessage("ERROR", "❌ Failed to refresh token for user:", userId);
        return { connected: false, authUrl };
      }
    }

    logMessage("INFO", "✅ Token is valid for user:", userId);
    return { connected: true, authUrl };
  } catch (error) {
    logMessage("ERROR", "❌ checkConnection error:", error);
    debugLog("checkConnection error details:", error);
    return { connected: false, authUrl };
  }
}

async function handleCallback(parseRedirectUrl, code, state) {
  const db = getDB();
  try {
    logMessage(
      "INFO",
      "🔄 Handling QuickBooks OAuth callback for user:",
      state
    );
    logMessage("INFO", "🔄 Redirect URL:", parseRedirectUrl);
    debugLog("OAuth callback parameters:", { code, state, parseRedirectUrl });

    await oauthClient.createToken(parseRedirectUrl);
    debugLog("OAuth client after createToken:", {
      hasToken: !!oauthClient.token,
      tokenKeys: oauthClient.token ? Object.keys(oauthClient.token) : [],
    });

    if (!oauthClient.token) {
      logMessage("ERROR", "❌ OAuth token is null or undefined");
      debugLog("createToken failed - no token created");
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
          ...oauthClient.token,
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

    await oauthClient.refreshUsingToken(tokenDoc.refresh_token);
    logMessage("INFO", "🔄 Refreshing token for user:", userId);

    // eslint-disable-next-line no-unused-vars
    await db.collection(QB_TOKEN_COLLECTION).updateOne(
      { userId },
      {
        $set: {
          ...tokenDoc,
          access_token: oauthClient.token.access_token,
          refresh_token: oauthClient.token.refresh_token,
          expires_in: oauthClient.token.expires_in,
          x_refresh_token_expires_in:
            oauthClient.token.x_refresh_token_expires_in,
          latency: oauthClient.token.latency,
          updated_at: new Date(),
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

async function getOrCreateCustomer(
  realmId,
  accessToken,
  contact,
  refreshToken
) {
  debugLog("Creating QuickBooks instance for customer lookup/creation", {
    realmId,
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    contactEmail: contact.email,
  });

  const qbo = new QuickBooks(
    process.env.QUICKBOOKS_CLIENT_ID,
    process.env.QUICKBOOKS_CLIENT_SECRET,
    accessToken,
    false,
    realmId,
    process.env.QUICKBOOKS_ENVIRONMENT === "sandbox" ? true : false,
    process.env.QUICKBOOKS_ENVIRONMENT === "sandbox" ? true : false,
    null,
    "2.0",
    refreshToken
  );

  const email = contact.email;
  let customerResponse;

  if (typeof qbo.findCustomers === "function") {
    customerResponse = await new Promise((resolve, reject) => {
      qbo.findCustomers(
        [{ field: "PrimaryEmailAddr", value: email, operator: "=" }],
        (err, data) => {
          if (err) {
            logMessage(
              "ERROR",
              "❌ Error finding customer:",
              err?.fault?.error
            );
            return reject(err);
          }
          resolve(data);
        }
      );
    });
  } else if (typeof qbo.query === "function") {
    const query = `SELECT * FROM Customer WHERE PrimaryEmailAddr = '${email}'`;
    customerResponse = await new Promise((resolve, reject) => {
      qbo.query(query, (err, data) => {
        if (err) {
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
  } else {
    throw new Error("No supported method to find customers on qbo instance");
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

  // Save customer to MongoDB (upsert by Id)
  try {
    await db
      .collection("quickbooks_hubspot_customers")
      .updateOne(
        { Id: customerId },
        { $set: customerDataToSave },
        { upsert: true }
      );
    logMessage("INFO", `✅ Saved QuickBooks customer ${customerId} to MongoDB`);
  } catch (err) {
    logMessage(
      "ERROR",
      `❌ Failed to save QuickBooks customer ${customerId} to MongoDB:`,
      err.message
    );
  }

  return customerId;
}

async function createInvoice(
  realmId,
  accessToken,
  refreshToken,
  customerId,
  deal
) {
  debugLog("Creating QuickBooks instance for invoice creation", {
    realmId,
    hasAccessToken: !!accessToken,
    hasRefreshToken: !!refreshToken,
    customerId,
    dealId: deal.id,
    dealAmount: deal.amount,
  });

  const qbo = new QuickBooks(
    process.env.QUICKBOOKS_CLIENT_ID,
    process.env.QUICKBOOKS_CLIENT_SECRET,
    accessToken,
    false,
    realmId,
    process.env.QUICKBOOKS_ENVIRONMENT === "sandbox" ? true : false,
    process.env.QUICKBOOKS_ENVIRONMENT === "sandbox" ? true : false,
    null,
    "2.0",
    refreshToken
  );

  console.log(
    "Creating QuickBooks invoice for customer:",
    customerId,
    "with deal amount:",
    deal.amount,
    "and deal ID:",
    deal.id
  );
  debugLog("Invoice creation details:", { customerId, deal });

  let itemId = "1";
  try {
    itemId = await getFirstItemId(qbo);
  } catch (e) {
    logMessage(
      "ERROR",
      "❌ Could not fetch Item ID, using default '1'",
      e.message
    );
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
  const invoiceUrl = `${QUICKBOOKS_APP_URL}?txnId=${invoiceId}`;
  return { invoiceNumber: invoiceId, invoiceUrl };
}

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

module.exports = {
  getAuthUri,
  handleCallback,
  handleRefreshToken,
  getOrCreateCustomer,
  createInvoice,
  checkConnection,
};
