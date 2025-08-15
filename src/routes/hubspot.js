const express = require("express");
const router = express.Router();
const hubspotController = require("../controllers/hubspotController");

router.get("/contact/:id", hubspotController.getContactById);
router.get("/deal/:id", hubspotController.getDealById);
router.get("/contacts", hubspotController.getAllContacts);
router.get("/deals", hubspotController.getAllDeals);
router.get(
  "/crm-card/:objectType/:objectId/:associationType",
  hubspotController.getCrmCardDetails
);
router.get(
  "/crm-card/:objectType/:subObjectType/:dealId",
  hubspotController.getCrmCardDetailsByDealId
);

router.get(
  "/associated-contacts/:dealId",
  hubspotController.getAssociatedContactsForDeal
);

// Quotes endpoints
router.get("/quote/:quoteId", hubspotController.getQuoteById);
router.get("/deal/:dealId/quotes", hubspotController.getQuotesByDealId);
router.get("/quote/:quoteId/line-items", hubspotController.getQuoteLineItems);
router.get("/line-item/:lineItemId", hubspotController.getLineItemById);

module.exports = router;
