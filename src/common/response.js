// Standardized API response utility
function successResponse(
  res,
  data = null,
  message = "Success",
  statusCode = 200
) {
  return res.status(statusCode).json({
    success: true,
    data,
    message,
    error: null,
  });
}

function errorResponse(res, error = null, message = "Error", statusCode = 500) {
  return res.status(statusCode).json({
    success: false,
    data: null,
    message,
    error,
  });
}

module.exports = {
  successResponse,
  errorResponse,
};
