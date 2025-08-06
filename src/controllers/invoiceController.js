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

exports.getInvoicesForDeal = async (req, res) => {
  const { dealId } = req.params;
  const { userId } = req.query;

  if (!dealId || !userId) {
    return errorResponse(
      res,
      "Deal ID and User ID are required",
      "Invalid request",
      400
    );
  }

  try {
    const result = await invoiceService.getInvoicesForDeal(dealId, userId);

    if (!result.invoices || result.invoices.length === 0) {
      return successResponse(res, [], "No invoices found for this deal");
    }

    successResponse(res, result.invoices, "Invoices retrieved successfully");
  } catch (error) {
    console.error("Error retrieving invoices for deal:", error);
    errorResponse(res, error.message, "Failed to retrieve invoices", 500);
  }
};
