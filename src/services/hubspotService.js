const crypto = require("crypto");
const HubspotClient = require("@hubspot/api-client");
const { getSecretStringFlexible } = require("../common/secrets");

let cachedHubspotToken = null;
let hubspotLoadedAt = 0;
const HUBSPOT_TTL = 10 * 60 * 1000;

async function getHubspotAccessToken() {
  // Prefer direct env var for local/dev
  if (process.env.HUBSPOT_API_KEY) {
    return process.env.HUBSPOT_API_KEY;
  }
  const now = Date.now();
  if (cachedHubspotToken && now - hubspotLoadedAt < HUBSPOT_TTL) return cachedHubspotToken;
  const secretName = process.env.HUBSPOT_API_KEY_SECRET_NAME;
  const token = await getSecretStringFlexible(secretName, [
    "HUBSPOT_API_KEY",
    "accessToken",
    "token",
    "apiKey",
  ]);
  cachedHubspotToken = token;
  hubspotLoadedAt = now;
  return token;
}

async function getHubspotClient() {
  const token = await getHubspotAccessToken();
  if (!token) {
    throw new Error("Missing HubSpot API token");
  }
  return new HubspotClient.Client({
    accessToken: token,
    numberOfApiCallRetries: 3,
  });
}

async function getHubSpotData(dealId, contactId) {
  // Get deal
  const hubspotClient = await getHubspotClient();
  const dealResponse = await hubspotClient.crm.deals.basicApi.getById(dealId, [
    "amount",
  ]);

  // Get contact
  const contactResponse = await hubspotClient.crm.contacts.basicApi.getById(
    contactId,
    ["email", "firstname", "lastname"]
  );

  return {
    deal: dealResponse.properties,
    contact: contactResponse.properties,
  };
}

async function updateHubSpotDeal(dealId, invoiceNumber, invoiceUrl) {
  const hubspotClient = await getHubspotClient();
  await hubspotClient.crm.deals.basicApi.update(dealId, {
    properties: {
      invoice_number: invoiceNumber,
      invoice_url: invoiceUrl,
    },
  });
}

// Get contact by ID with custom properties
async function getContactById(
  contactId,
  properties = ["email", "firstname", "lastname"]
) {
  const hubspotClient = await getHubspotClient();
  const contactResponse = await hubspotClient.crm.contacts.basicApi.getById(
    contactId,
    properties
  );
  return contactResponse.properties;
}

// Get deal by ID with custom properties
async function getDealById(dealId, properties = ["amount"]) {
  const hubspotClient = await getHubspotClient();
  const dealResponse = await hubspotClient.crm.deals.basicApi.getById(
    dealId,
    properties
  );
  return dealResponse.properties;
}

// Get deal by ID with custom properties
async function getAssociatedContactsForDeal(dealId) {
  const result = [];

  const requestBody = {
    inputs: [dealId].map((id) => ({ id })),
  };

  // Get associations for the deal
  const hubspotClient = await getHubspotClient();
  const associations = await hubspotClient.crm.associations.v4.batchApi.getPage(
    "deals",
    "contacts",
    requestBody
  );

  for (const association of associations.results) {
    for (const item of association.to) {
      if (!item.associationTypes.some((type) => type.typeId === 3)) {
        continue; // Skip if not a contact association
      }

      const contactId = item.toObjectId;
  const hubspotClient2 = await getHubspotClient();
  const contact = await hubspotClient2.crm.contacts.basicApi.getById(
        contactId,
        ["email", "firstname", "lastname"]
      );

      result.push({
        id: contactId,
        email: contact.properties.email,
        firstname: contact.properties.firstname,
        lastname: contact.properties.lastname,
      });
    }
  }

  return result;
}

// Get all contacts (paginated)
async function getAllContacts(limit = 10, after = undefined) {
  const hubspotClient = await getHubspotClient();
  const response = await hubspotClient.crm.contacts.basicApi.getPage(
    limit,
    undefined,
    ["email", "firstname", "lastname"],
    after
  );
  return response.results.map((c) => c.properties);
}

// Get all deals (paginated)
async function getAllDeals(limit = 10, after = undefined) {
  const hubspotClient = await getHubspotClient();
  const response = await hubspotClient.crm.deals.basicApi.getPage(
    limit,
    undefined,
    ["amount"],
    after
  );
  return response.results.map((d) => d.properties);
}

// Get CRM card details (custom objects or associations)
async function getCrmCardDetails(objectType, objectId, associationType) {
  const hubspotClient = await getHubspotClient();
  const response = await hubspotClient.crm.associations.v4.basicApi.getPage(
    objectType,
    objectId,
    associationType
  );
  return response.results;
}

// Get CRM card details by deal ID (custom implementation)
async function getCrmCardDetailsByDealId(objectType, subObjectType, dealId) {
  const requestBody = {
    inputs: [dealId].map((id) => ({ id })),
  };

  const hubspotClient = await getHubspotClient();
  const response = await hubspotClient.crm.associations.v4.basicApi.getPage(
    objectType,
    subObjectType,
    requestBody
  );
  return response.results;
}

// Validate HubSpot request signature
function validateHubSpotRequest(req) {
  const signatureHeader = req.headers["x-hubspot-signature-v3"];
  const timestampHeader = req.headers["x-hubspot-request-timestamp"];

  if (!signatureHeader || !timestampHeader) {
    return { valid: false, reason: "Missing signature or timestamp header" };
  }

  // Validate timestamp
  console.log(`Signature: ${signatureHeader}, Timestamp: ${timestampHeader}`);

  const MAX_ALLOWED_TIMESTAMP = 300000; // 5 minutes in ms
  const currentTime = Date.now();
  if (
    !timestampHeader ||
    currentTime - Number(timestampHeader) > MAX_ALLOWED_TIMESTAMP
  ) {
    return { valid: false, reason: "Invalid or expired timestamp" };
  }

  // Build raw string for signature
  const uri = `https://${req.hostname}${req.url}`;
  const rawString = `${req.method}${uri}${JSON.stringify(req.body)}${timestampHeader}`;

  // Compute HMAC SHA-256 hash
  const clientSecret = process.env.CLIENT_SECRET;
  if (!clientSecret) {
    return { valid: false, reason: "Missing CLIENT_SECRET" };
  }
  const hashedString = crypto
    .createHmac("sha256", clientSecret)
    .update(rawString)
    .digest("base64");

  // Validate signature
  if (
    signatureHeader &&
    crypto.timingSafeEqual(
      Buffer.from(hashedString),
      Buffer.from(signatureHeader)
    )
  ) {
    return { valid: true };
  } else {
    return { valid: false, reason: "Signature mismatch" };
  }
}

module.exports = {
  getHubSpotData,
  updateHubSpotDeal,
  getContactById,
  getDealById,
  getAllContacts,
  getAllDeals,
  getCrmCardDetails,
  getCrmCardDetailsByDealId,
  validateHubSpotRequest,
  getAssociatedContactsForDeal,
};
