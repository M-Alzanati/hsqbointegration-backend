const hubspotService = require("../services/hubspotService");
const { successResponse, errorResponse } = require("../common/response");

const getContactById = async (req, res) => {
  try {
    const contact = await hubspotService.getContactById(req.params.id);
    successResponse(res, contact, "✅ Contact fetched successfully");
  } catch (error) {
    errorResponse(res, error.message, "❌ Failed to fetch contact", 500);
  }
};

const getDealById = async (req, res) => {
  try {
    const deal = await hubspotService.getDealById(req.params.id);
    successResponse(res, deal, "✅ Deal fetched successfully");
  } catch (error) {
    errorResponse(res, error.message, "❌ Failed to fetch deal", 500);
  }
};

const getAllContacts = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const after = req.query.after;
    const contacts = await hubspotService.getAllContacts(limit, after);
    successResponse(res, contacts, "✅ Contacts fetched successfully");
  } catch (error) {
    errorResponse(res, error.message, "❌ Failed to fetch contacts", 500);
  }
};

const getAllDeals = async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 10;
    const after = req.query.after;
    const deals = await hubspotService.getAllDeals(limit, after);
    successResponse(res, deals, "✅ Deals fetched successfully");
  } catch (error) {
    errorResponse(res, error.message, "❌ Failed to fetch deals", 500);
  }
};

const getCrmCardDetails = async (req, res) => {
  try {
    const { objectType, objectId, associationType } = req.params;
    const details = await hubspotService.getCrmCardDetails(
      objectType,
      objectId,
      associationType
    );
    successResponse(res, details, "✅ CRM card details fetched successfully");
  } catch (error) {
    errorResponse(
      res,
      error.message,
      "❌ Failed to fetch CRM card details",
      500
    );
  }
};

const getCrmCardDetailsByDealId = async (req, res) => {
  try {
    const { objectType, subObjectType, dealId } = req.params;
    const details = await hubspotService.getCrmCardDetailsByDealId(
      objectType,
      subObjectType,
      dealId
    );
    successResponse(
      res,
      details,
      "✅ CRM card details by deal ID fetched successfully"
    );
  } catch (error) {
    errorResponse(
      res,
      error.message,
      "❌ Failed to fetch CRM card details by deal ID",
      500
    );
  }
};

const getAssociatedContactsForDeal = async (req, res) => {
  try {
    const { dealId } = req.params;
    const contacts = await hubspotService.getAssociatedContactsForDeal(dealId);
    successResponse(
      res,
      contacts,
      "✅ Associated contacts fetched successfully"
    );
  } catch (error) {
    errorResponse(
      res,
      error.message,
      "❌ Failed to fetch associated contacts",
      500
    );
  }
};

const getQuoteById = async (req, res) => {
  try {
    const { quoteId } = req.params;
    const quote = await hubspotService.getQuoteById(quoteId);
    successResponse(res, quote, "✅ Quote fetched successfully");
  } catch (error) {
    errorResponse(res, error.message, "❌ Failed to fetch quote", 500);
  }
};

const getQuotesByDealId = async (req, res) => {
  try {
    const { dealId } = req.params;
    const quotes = await hubspotService.getQuotesByDealId(dealId);
    successResponse(res, quotes, "✅ Quotes fetched successfully");
  } catch (error) {
    errorResponse(res, error.message, "❌ Failed to fetch quotes", 500);
  }
};

module.exports = {
  getContactById,
  getDealById,
  getAllContacts,
  getAllDeals,
  getCrmCardDetails,
  getCrmCardDetailsByDealId,
  getAssociatedContactsForDeal,
  getQuoteById,
  getQuotesByDealId,
};
