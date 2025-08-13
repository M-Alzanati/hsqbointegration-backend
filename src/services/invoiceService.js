const { getDB } = require("../config/db");
const hubspotService = require("./hubspotService");
const quickbooksService = require("./quickbooksService");

const { logMessage } = require("../common/logger");
const { QB_INVOICE_COLLECTION } = require("../models/constants");

/** * Handle creating an invoice in QuickBooks
 * @param {Object} params - Parameters containing userId, dealId, and contactId
 * @returns {Promise<Object>} - Returns an object with invoice details or error
 */
async function handleCreateInvoice({ userId, dealId, contactId }) {
  const db = getDB();
  let accessToken, refreshToken, realmId;
  logMessage("DEBUG", "🐛 handleCreateInvoice called", {
    userId,
    dealId,
    contactId,
  });

  try {
    // Use global/shared QuickBooks tokens (single-company mode)
    const globalTokens = await quickbooksService.getGlobalTokens();
    if (!globalTokens) {
      logMessage("WARN", "⚠️ QuickBooks not connected (global token missing)");
      return { error: "❌ QuickBooks not connected", status: 400 };
    }

    accessToken = globalTokens.accessToken;
    refreshToken = globalTokens.refreshToken;
    realmId = globalTokens.realmId;

    if (!accessToken || !refreshToken || !realmId) {
      logMessage("WARN", "⚠️ Missing global QuickBooks tokens", {
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refreshToken,
        hasRealmId: !!realmId,
      });
      return { error: "❌ Missing QuickBooks tokens", status: 400 };
    }

    // Get deal and contact from HubSpot
    logMessage(
      "INFO",
      "🔄 Fetching HubSpot data for deal:",
      dealId,
      "and contact:",
      contactId
    );
    logMessage("INFO", "🔄 Fetching deal and contact from HubSpot", {
      dealId,
      contactId,
    });
    const { deal, contact } = await hubspotService.getHubSpotData(
      dealId,
      contactId
    );
  logMessage("DEBUG", "🐛 Fetched HubSpot data", {
      dealProps: Object.keys(deal || {}),
      contactProps: Object.keys(contact || {}),
    });

    // Find or create customer in QuickBooks
    logMessage(
      "INFO",
      "🔄 Finding or creating QuickBooks customer for contact:",
      contactId
    );
    logMessage("INFO", "🔄 Invoking getOrCreateCustomer", {
      userId,
      contactEmail: contact?.email,
    });
    const customerId = await quickbooksService.getOrCreateCustomer(
      realmId,
      accessToken,
      { ...contact, id: contact.hs_object_id },
      refreshToken
    );
  logMessage("INFO", "✅ QuickBooks customer resolved", { customerId });

    // Create invoice in QuickBooks
  logMessage("INFO", "🔄 Creating QuickBooks invoice for deal:", dealId);
    deal.id = dealId;

  logMessage("INFO", "🔄 Calling createInvoice", { dealId, customerId });
    const { invoiceNumber, invoiceUrl } = await quickbooksService.createInvoice(
      realmId,
      accessToken,
      refreshToken,
      customerId,
      deal
    );

    if (!invoiceNumber || !invoiceUrl) {
      throw new Error("❌ Failed to create invoice in QuickBooks");
    }

    logMessage(
      "INFO",
      "✅ Invoice created successfully:",
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
      "🔄 Updating HubSpot deal with invoice info for deal:",
      dealId
    );
    logMessage("INFO", "🔄 Updating HubSpot deal with invoice data", {
      dealId,
      invoiceNumber,
    });

    await hubspotService.updateHubSpotDeal(dealId, invoiceNumber, invoiceUrl);
  logMessage("DEBUG", "✅ HubSpot deal updated", { dealId });

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
  logMessage("INFO", "✅ Saved invoice document in DB", {
      userId,
      dealId,
      contactId,
      customerId,
      invoiceNumber,
    });

    return { invoiceNumber, invoiceUrl };
  } catch (error) {
  logMessage("ERROR", "❌ handleCreateInvoice error", {
      userId,
      dealId,
      contactId,
      message: error?.message,
    });
    if (error.statusCode === 401) {
      // Refresh global tokens and ask client to retry
      await quickbooksService.getGlobalTokens();
      return { error: "❌ Token refreshed, please retry", status: 503 };
    }

    logMessage(
      "ERROR",
      "❌ Error in handleCreateInvoice:",
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
  logMessage("DEBUG", "🐛 getInvoicesForDeal called", { dealId, userId });

  try {
    // Get invoices from MongoDB
    const dbInvoices = await db
      .collection(QB_INVOICE_COLLECTION)
      .find({ dealId })
      .toArray();
  logMessage("INFO", "📄 Loaded invoices from DB for deal", {
      dealId,
      count: (dbInvoices || []).length,
    });

    if (!dbInvoices || dbInvoices.length === 0) {
      logMessage("INFO", "ℹ️ No invoices found for deal:", dealId);
      return { invoices: [], quickbooksInvoices: [] };
    }

    logMessage("INFO", "📄 Invoices found for deal:", dealId, dbInvoices.length);

    // Get global QuickBooks tokens
    const globalTokens = await quickbooksService.getGlobalTokens();
    if (!globalTokens) {
      logMessage("WARN", "⚠️ QuickBooks not connected (global token missing)");
      return { error: "❌ QuickBooks not connected", status: 400 };
    }

    const accessToken = globalTokens.accessToken;
    const refreshToken = globalTokens.refreshToken;
    const realmId = globalTokens.realmId;

    if (!accessToken || !refreshToken || !realmId) {
      logMessage("WARN", "⚠️ Missing global QuickBooks tokens", {
        hasAccessToken: !!accessToken,
        hasRefreshToken: !!refreshToken,
        hasRealmId: !!realmId,
      });
      return { error: "❌ Missing QuickBooks tokens", status: 400 };
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
  logMessage("DEBUG", "🐛 Verified invoices in QuickBooks", {
      requested: invoiceIds.length,
      returned: quickbooksInvoiceValidity
        ? Object.keys(quickbooksInvoiceValidity).length
        : 0,
    });

    // Only proceed with deletion if validity is a non-empty object
    let invoicesWithValidity = dbInvoices;

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
          `✅ Removed ${deletedInvoiceIds.length} invoices from DB that were deleted in QuickBooks.`
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

  logMessage("INFO", "✅ Returning invoices for deal", {
      dealId,
      count: (invoicesWithValidity || []).length,
    });
    return { invoices: invoicesWithValidity };
  } catch (error) {
    logMessage(
      "ERROR",
      "❌ Error in getInvoicesForDeal:",
      error && error.stack ? error.stack : JSON.stringify(error)
    );
    return { error: error.message, status: 500 };
  }
}

module.exports = {
  handleCreateInvoice,
  getInvoicesForDeal,
};
