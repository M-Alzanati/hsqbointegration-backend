const quickbooksService = require("../services/quickbooksService");
const { successResponse, errorResponse } = require("../common/response");

exports.createConnection = async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return errorResponse(res, "User ID is required", "Invalid request", 400);
  }
  try {
    const authUrl = await quickbooksService.getAuthUri(userId);
    successResponse(res, { authUrl }, "Connection created successfully");
  } catch (error) {
    console.error("Error creating QuickBooks connection:", error);
    errorResponse(res, error.message, "Failed to create connection", 500);
  }
};

exports.checkConnection = async (req, res) => {
  const { userId } = req.query;
  if (!userId) {
    return errorResponse(res, "User ID is required", "Invalid request", 400);
  }

  try {
    const result = await quickbooksService.checkConnection(userId);
    successResponse(res, result, "Connection status retrieved successfully");
  } catch (error) {
    console.error("Error checking QuickBooks connection:", error);
    errorResponse(res, error.message, "Failed to check connection", 500);
  }
};

exports.connectQuickBooks = async (req, res) => {
  const authUri = await quickbooksService.getAuthUri(req.query.userId);
  res.redirect(authUri);
};

exports.quickBooksCallback = async (req, res) => {
  const parseRedirect = req.url;
  const { state, code } = req.query;

  const result = await quickbooksService.handleCallback(
    parseRedirect,
    code,
    state
  );

  if (result.success) {
    console.log("✅ QuickBooks connected successfully for user:", state);

    res.send(`
    <html>
      <body>
        <script>
          window.close();
          setTimeout(function() {
            document.body.innerHTML = "<h2>You can close this tab now.</h2>";
          }, 500);
        </script>
      </body>
    </html>
  `);
  } else {
    errorResponse(res, result.error, "Failed to connect QuickBooks", 500);
  }
};

exports.refreshToken = async (req, res) => {
  const { userId } = req.query;
  const result = await quickbooksService.handleRefreshToken(userId);
  if (result.success) {
    successResponse(res, result, "Token refreshed successfully");
  } else {
    errorResponse(
      res,
      result.error,
      "Failed to refresh token",
      result.status || 500
    );
  }
};
