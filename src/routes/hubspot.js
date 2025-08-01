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

module.exports = router;
