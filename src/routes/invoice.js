const express = require("express");
const router = express.Router();
const invoiceController = require("../controllers/invoiceController");

router.post("/create-invoice", invoiceController.createInvoice);
router.get("/deals/:dealId", invoiceController.getInvoicesForDeal);

module.exports = router;
