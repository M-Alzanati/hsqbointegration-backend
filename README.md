# HubSpot-QuickBooks Backend

This backend service integrates HubSpot CRM with QuickBooks Online, allowing you to create QuickBooks invoices from HubSpot deals and sync customer/contact information.

## Features

- Connect your QuickBooks account via OAuth2.
- Refresh QuickBooks tokens securely.
- Fetch HubSpot deal and contact data.
- Create QuickBooks invoices from HubSpot deals.
- Update HubSpot deals with invoice information.

## Setup

1. **Clone the repository**

   ```sh
   git clone https://github.com/yourusername/hubspot-quickbooks-backend.git
   cd hubspot-quickbooks-backend/src
   npm install
   ```

2. **Create a `.env` file** in the root directory and add your configuration:

   ```env
   PORT=3000
   HUBSPOT_API_KEY=your_hubspot_api_key
   QUICKBOOKS_CLIENT_ID=your_quickbooks_client_id
   QUICKBOOKS_CLIENT_SECRET=your_quickbooks_client_secret
   QUICKBOOKS_REDIRECT_URI=http://localhost:3000/callback
   MONGODB_URI=mongodb://localhost:27017/quickbooks_db
   BACKEND_API_KEY=your_backend_api_key
   ```

3. **Run the application**
   ```sh
   npm start
   ```

## Usage

- Navigate to `http://localhost:3000` to access the API endpoints.
- Use tools like Postman or Curl to interact with the API.
- Refer to the API documentation for endpoint details and usage examples.
