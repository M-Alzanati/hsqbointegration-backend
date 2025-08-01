const { getDB } = require("../config/db");
const hubspotService = require("./hubspotService");
const quickbooksService = require("./quickbooksService");

const { logMessage } = require("../common/logger");
const {
  QB_TOKEN_COLLECTION,
  QB_INVOICE_COLLECTION,
} = require("../models/constants");

async function handleCreateInvoice({ userId, dealId, contactId }) {
  const db = getDB();
  let accessToken, refreshToken, realmId;

  try {
    const tokenDoc = await db
      .collection(QB_TOKEN_COLLECTION)
      .findOne({ userId });

    if (!tokenDoc) {
      logMessage("WARN", "QuickBooks not connected for user:", userId);
      return { error: "QuickBooks not connected", status: 400 };
    }

    accessToken = tokenDoc.access_token;
    refreshToken = tokenDoc.refresh_token;
    realmId = tokenDoc.realmId;

    if (!accessToken || !refreshToken || !realmId) {
      logMessage("WARN", "Missing QuickBooks tokens for user:", userId);
      return { error: "Missing QuickBooks tokens", status: 400 };
    }

    // Get deal and contact from HubSpot
    logMessage(
      "INFO",
      "Fetching HubSpot data for deal:",
      dealId,
      "and contact:",
      contactId
    );
    const { deal, contact } = await hubspotService.getHubSpotData(
      dealId,
      contactId
    );

    // Find or create customer in QuickBooks
    logMessage(
      "INFO",
      "Finding or creating QuickBooks customer for contact:",
      contactId
    );
    const customerId = await quickbooksService.getOrCreateCustomer(
      realmId,
      accessToken,
      { ...contact, id: contact.hs_object_id },
      refreshToken
    );

    // Create invoice in QuickBooks
    logMessage("INFO", "Creating QuickBooks invoice for deal:", dealId);
    deal.id = dealId;

    const { invoiceNumber, invoiceUrl } = await quickbooksService.createInvoice(
      realmId,
      accessToken,
      refreshToken,
      customerId,
      deal
    );

    if (!invoiceNumber || !invoiceUrl) {
      throw new Error("Failed to create invoice in QuickBooks");
    }
    logMessage(
      "INFO",
      "Invoice created successfully:",
      invoiceNumber,
      invoiceUrl
    );

    // Update HubSpot deal with invoice info
    logMessage(
      "INFO",
      "Updating HubSpot deal with invoice info for deal:",
      dealId
    );
    await hubspotService.updateHubSpotDeal(dealId, invoiceNumber, invoiceUrl);

    // Save invoice to MongoDB
    const invoiceDoc = {
      userId,
      dealId,
      contactId,
      invoiceNumber,
      invoice_id: invoiceNumber, // for unique index
      invoiceUrl,
      createdAt: new Date(),
    };

    await db.collection(QB_INVOICE_COLLECTION).insertOne(invoiceDoc);

    return { invoiceNumber, invoiceUrl };
  } catch (error) {
    if (error.statusCode === 401) {
      await quickbooksService.handleRefreshToken(userId);
      // Retry logic can be added here
      return { error: "Token refreshed, please retry", status: 503 };
    }

    logMessage(
      "ERROR",
      "Error in handleCreateInvoice:",
      error && error.stack ? error.stack : JSON.stringify(error)
    );
    return { error: error.message, status: 500 };
  }
}

module.exports = {
  handleCreateInvoice,
};
