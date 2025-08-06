const { getDB } = require("../config/db");
const hubspotService = require("./hubspotService");
const quickbooksService = require("./quickbooksService");

const { logMessage } = require("../common/logger");
const {
  QB_TOKEN_COLLECTION,
  QB_INVOICE_COLLECTION,
} = require("../models/constants");

/** * Handle creating an invoice in QuickBooks
 * @param {Object} params - Parameters containing userId, dealId, and contactId
 * @returns {Promise<Object>} - Returns an object with invoice details or error
 */
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

    accessToken = tokenDoc.accessToken;
    refreshToken = tokenDoc.refreshToken;
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
      invoiceUrl,
      "for deal:",
      dealId,
      ", customer:",
      customerId,
      ", contact:",
      contactId,
      ", user:",
      userId
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
      customerId,
      invoiceNumber,
      invoiceId: invoiceNumber, // for unique index
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

/** * Fetch invoices for a specific customer
 * @param {Object} params - Parameters containing userId and customerId
 * @returns {Promise<Object>} - Returns an object with invoices or error
 */
async function getInvoicesForDeal(dealId, userId) {
  const db = getDB();
  logMessage(
    "DEBUG",
    "Fetching invoices for deal:",
    dealId,
    "and user:",
    userId
  );

  try {
    // Get invoices from MongoDB
    const dbInvoices = await db
      .collection(QB_INVOICE_COLLECTION)
      .find({ dealId })
      .toArray();

    if (!dbInvoices || dbInvoices.length === 0) {
      logMessage("INFO", "No invoices found for deal:", dealId);
      return { invoices: [], quickbooksInvoices: [] };
    }

    logMessage("INFO", "Invoices found for deal:", dealId, dbInvoices.length);

    // Get QuickBooks tokens
    const tokenDoc = await db
      .collection(QB_TOKEN_COLLECTION)
      .findOne({ userId });

    if (!tokenDoc) {
      logMessage("WARN", "QuickBooks not connected for user:", userId);
      return { error: "QuickBooks not connected", status: 400 };
    }

    const accessToken = tokenDoc.accessToken;
    const refreshToken = tokenDoc.refreshToken;
    const realmId = tokenDoc.realmId;

    if (!accessToken || !refreshToken || !realmId) {
      logMessage("WARN", "Missing QuickBooks tokens for user:", userId);
      return { error: "Missing QuickBooks tokens", status: 400 };
    }

    // Batch verify all invoiceNumbers in QuickBooks
    const invoiceIds = dbInvoices.map(
      (inv) => inv.invoiceNumber || inv.invoiceId
    );

    const quickbooksInvoiceValidity =
      await quickbooksService.verifyInvoicesInQuickBooks(
        realmId,
        accessToken,
        refreshToken,
        invoiceIds
      );

    // Only proceed with deletion if validity is a non-empty object
    let invoicesWithValidity = dbInvoices;
    console.log("QuickBooks invoice validity:", quickbooksInvoiceValidity);

    if (
      quickbooksInvoiceValidity &&
      typeof quickbooksInvoiceValidity === "object" &&
      Object.keys(quickbooksInvoiceValidity).length > 0
    ) {
      // Remove invoices from DB that are deleted in QuickBooks
      const deletedInvoiceIds = dbInvoices
        .filter(
          (inv) =>
            !quickbooksInvoiceValidity[inv.invoiceNumber || inv.invoiceId]
        )
        .map((inv) => inv._id);

      if (deletedInvoiceIds.length > 0) {
        await db
          .collection(QB_INVOICE_COLLECTION)
          .deleteMany({ _id: { $in: deletedInvoiceIds } });

        logMessage(
          "INFO",
          `Removed ${deletedInvoiceIds.length} invoices from DB that were deleted in QuickBooks.`
        );
      }

      // Attach validity and filter out deleted invoices
      invoicesWithValidity = dbInvoices
        .map((inv) => ({
          ...inv,
          isValidInQuickBooks:
            quickbooksInvoiceValidity[inv.invoiceNumber || inv.invoiceId] ||
            false,
        }))
        .filter((inv) => inv.isValidInQuickBooks);
    }

    return { invoices: invoicesWithValidity };
  } catch (error) {
    logMessage(
      "ERROR",
      "Error in getInvoicesForDeal:",
      error && error.stack ? error.stack : JSON.stringify(error)
    );
    return { error: error.message, status: 500 };
  }
}

module.exports = {
  handleCreateInvoice,
  getInvoicesForDeal,
};
