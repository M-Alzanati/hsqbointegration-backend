const invoiceService = require("../services/invoiceService");
const { successResponse, errorResponse } = require("../common/response");

exports.createInvoice = async (req, res) => {
  const { userId, dealId, contactId } = req.query;
  const result = await invoiceService.handleCreateInvoice({
    userId,
    dealId,
    contactId,
  });

  if (result.error) {
    return errorResponse(
      res,
      result.error,
      "Failed to create invoice",
      result.status || 500
    );
  }

  successResponse(
    res,
    { invoiceNumber: result.invoiceNumber, invoiceUrl: result.invoiceUrl },
    "Invoice created successfully"
  );
};
