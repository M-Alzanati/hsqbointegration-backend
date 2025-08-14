const express = require("express");
const router = express.Router();
const quickbooksController = require("../controllers/quickbooksController");

router.get("/connect", quickbooksController.connectQuickBooks);
router.get("/checkConnection", quickbooksController.checkConnection);
router.get("/authUrl", quickbooksController.createConnection);
router.get("/callback", quickbooksController.quickBooksCallback);
router.get("/refresh-token", quickbooksController.refreshToken);

module.exports = router;
