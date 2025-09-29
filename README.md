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
   # HubSpot → QuickBooks Backend

   Lightweight backend to integrate HubSpot CRM with QuickBooks Online (QBO). The service supports:

   - Connecting a QuickBooks Online company via OAuth2.
   - Storing and refreshing a shared (global) QBO token in MongoDB.
   - Creating QuickBooks invoices from HubSpot deals and associating customers.
   - Basic HubSpot webhook and invoice endpoints guarded by an API key.

   This README documents how to run locally, environment variables, useful developer tips, and deployment steps used by the project.

   ## Quick start (local)

   1. Clone and install dependencies:

   ```powershell
   git clone <repo-url>
   cd hsqbointegration-backend/src
   npm install
   ```

   2. Create a `.env` file in the `src/` directory or set environment variables. At minimum, these are required for local runs (see `src/config/env.js`):

   ```env
   PORT=3000
   QUICKBOOKS_CLIENT_ID=<your_quickbooks_client_id>
   QUICKBOOKS_CLIENT_SECRET=<your_quickbooks_client_secret>
   QUICKBOOKS_ENVIRONMENT=sandbox # or production
   QUICKBOOKS_REDIRECT_URI=http://localhost:3000/quickbooks/callback
   QUICKBOOKS_APP_URL=https://sandbox.qbo.intuit.com/app/invoice
   MONGODB_URI=mongodb://localhost:27017/quickbooks_db
   HUBSPOT_API_KEY=<your_hubspot_api_key>
   ```

   Notes:
   - The app expects additional environment variables (secrets) when deployed to Lambda; see the `app.yaml` / CloudFormation template for full environment wiring.

   3. Start the server locally:

   ```powershell
   npm start
   ```

   The server listens on `PORT` (default 3000). Visit `http://localhost:3000/health` (API key required in production) or `http://localhost:3000` for a basic message.

   ## Important environment variables

   Core variables used by the service (non-exhaustive):

   - QUICKBOOKS_CLIENT_ID / QUICKBOOKS_CLIENT_SECRET — QuickBooks app credentials.
   - QUICKBOOKS_REDIRECT_URI — OAuth redirect URL for QuickBooks app.
   - QUICKBOOKS_ENVIRONMENT — `sandbox` or `production`.
   - QUICKBOOKS_APP_URL — base URL for direct invoice links.
   - MONGODB_URI — MongoDB connection string.
   - HUBSPOT_API_KEY — HubSpot API key used by HubSpot routes.
   - QUICKBOOKS_TAX_CODE_NAMES — Comma-separated preferred tax code names (e.g., "GST/HST,GST 5%") used to match tax code by name.
   - QUICKBOOKS_GST_TAX_CODE_ID — Optional override: numeric TaxCode Id for GST 5% (company-specific). If set, the service will use this ID directly.
   - QUICKBOOKS_BYPASS_TAX_CODE — `true` to omit TaxCodeRef on lines.

   See `src/config/env.js` and `app.yaml` for how the project wires many of these at deploy time.

   ## How the service selects TaxCode for GST 5%

   Tax codes are company-specific in QuickBooks Online. The service selects a tax code in this order:

   1. If `QUICKBOOKS_GST_TAX_CODE_ID` is set, use that ID immediately.
   2. If `QUICKBOOKS_TAX_CODE_NAMES` contains preferred names, try those.
   3. Strong preference for names matching common GST 5% patterns (e.g., "GST 5%", "GST (5%)").
   4. Fallback to common Canadian codes like `GST`, `HST`, `GST/HST`, `QST`, `PST`, etc.

   If you don't know the numeric TaxCode ID you can query QuickBooks using the SDK/Query API:

   ```sql
   SELECT Id, Name FROM TaxCode WHERE Name = 'GST 5%'
   ```

   Or call `qbo.findTaxCodes({}, callback)` and inspect the returned list for the desired Name/Id.

   Once you have the numeric Id, set `QUICKBOOKS_GST_TAX_CODE_ID` in your environment (or CloudFormation `app.yaml`) so the service can reliably pick the correct TaxCode.

   ## Creating invoices and invoice line names

   - The service will attempt to include a product/service name on the invoice line by setting `ItemRef.name` in each `SalesItemLineDetail`.
   - If `options.qbLines` is provided to `createInvoice`, each `qbLines` entry may include `itemName` or `name`. The service uses that value. Otherwise it falls back to the first item returned by `qbo.findItems()` and uses its `Name`.

   If you want specific ItemRefs per-line, extend `options.qbLines` to include `itemId` and `itemName` for each line; the service will honor `itemName` if provided.

   ## Build & deploy

   The repository includes utility npm scripts to build and package the Lambda bundle and a CloudFormation template (`cloudformation.yaml`) and `app.yaml` that define environment wiring used in deployment.

   - Build locally (produces bundle/ and hubspot-quickbooks-backend.zip):

   ```powershell
   npm run build
   npm run package-lambda
   ```

   - Upload and update Lambda (requires AWS CLI credentials):

   ```powershell
   npm run upload-lambda-zip
   npm run update-lambda-code
   ```

   - Full CloudFormation deploy (example command in `package.json`):

   ```powershell
   npm run deploy-cloudformation
   ```

   ## Developer notes

   - Server entrypoint: `src/server.js` (runs locally). Lambda uses `src/lambda.js` which wraps the Express app via `@vendia/serverless-express`.
   - DB connection helpers are in `src/config/db.js` and environment validation in `src/config/env.js`.
   - OAuth flow for QuickBooks is implemented in `src/services/quickbooksService.js` and routed under `/quickbooks` in `src/routes/quickbooks.js`.
   - Log output is emitted using `src/common/logger.js` — check CloudWatch when running in Lambda.

   ## How to find TaxCode Id programmatically (example)

   Add a small script or temporarily log results from `qbo.findTaxCodes({}, (err, data) => ...)` using a valid `qbo` instance (see `getQBOInstance` in `src/services/quickbooksService.js`). The returned object contains `QueryResponse.TaxCode` entries with `Id` and `Name` you can copy into your env.

   ## AWS infrastructure (CloudFormation)

   This project uses modular CloudFormation templates located under `src/` to provision the AWS infrastructure required to run the backend. The templates are intentionally split so you can deploy and manage resources independently (networking, data, secrets, deployment artifacts, and application stacks).

   Core stacks and responsibilities

   - `src/network.yaml` — VPC, subnets (public + private), NAT gateway, route tables and a `LambdaSecurityGroup`. Exports: `hsqbo:network:PrivateSubnet1Id`, `hsqbo:network:PrivateSubnet2Id`, `hsqbo:network:LambdaSecurityGroupId`, etc.
   - `src/secrets-only.yaml` — Creates Secrets Manager secrets used by the application (DocumentDB password, service API key, QuickBooks client id/secret, HubSpot API key). Secrets are created with `DeletionPolicy: Retain` to avoid accidental data loss.
   - `src/data-create.yaml` — Provisions an Amazon DocumentDB cluster (MongoDB-compatible), a DB subnet group and a security group that allows access from the Lambda security group.
   - `src/bucket-only.yaml` — Private S3 bucket for Lambda deployment artifacts (versioned).
   - `src/bastion.yaml` — Optional EC2 bastion host (with SSM support) for administrative access to DocumentDB if required.
   - `src/app.yaml` — Application stack. Creates IAM roles (with least-privilege recommendations supplied in-line), Lambda functions, API Gateway (HTTP API), CloudWatch LogGroups and wires environment variables. Lambdas are deployed into private subnets and reference the exported subnet IDs and security group.

   High-level architecture

   - The API is implemented as an Express app packaged as a Lambda and exposed via API Gateway HTTP API. The Lambda runs in private subnets so it can access the DocumentDB cluster.
   - Secrets (QuickBooks client secrets, HubSpot API key, DB password) are stored in AWS Secrets Manager; the Lambda role is granted `secretsmanager:GetSecretValue` to read them at runtime.
   - DocumentDB stores application state including QuickBooks tokens and customer mappings.
   - CloudWatch LogGroups capture Lambda logs and API Gateway access logs created by the `app.yaml` template.

   Deployment order (recommended)

   1. Network — deploy `src/network.yaml` (or set `UseExistingVpc=true` to reuse an existing VPC). This creates the VPC, subnets, and the Lambda security group exports used by other stacks.
   2. Secrets — deploy `src/secrets-only.yaml` to create required Secrets Manager entries. Populate secrets via the console or CLI after stack creation where applicable.
   3. Bucket — deploy `src/bucket-only.yaml` to provision the private S3 bucket used to upload Lambda artifacts.
   4. Data — deploy `src/data-create.yaml` to provision DocumentDB. This stack consumes network exports.
   5. Build & upload — run the project build to create the Lambda ZIP (`npm run package-lambda`) and upload it to the S3 deployment bucket.
   6. App — deploy `src/app.yaml` and provide parameters: `LambdaDeploymentBucket`, `LambdaS3Key`, `DocDBClusterEndpoint`, `DocDBClusterIdentifier`, `DocDBMasterUsername`, `StageName`, `QuickBooksEnvironment`, etc.

   Quick deploy examples (PowerShell)

   ```powershell
   # Deploy network
   aws cloudformation deploy --template-file src/network.yaml --stack-name hubspot-network --capabilities CAPABILITY_NAMED_IAM --parameter-overrides VpcCidr=10.0.0.0/16

   # Create secrets
   aws cloudformation deploy --template-file src/secrets-only.yaml --stack-name hubspot-secrets --capabilities CAPABILITY_NAMED_IAM

   # Create bucket
   aws cloudformation deploy --template-file src/bucket-only.yaml --stack-name hubspot-bucket --capabilities CAPABILITY_NAMED_IAM

   # Create DocumentDB
   aws cloudformation deploy --template-file src/data-create.yaml --stack-name hubspot-docdb --capabilities CAPABILITY_NAMED_IAM --parameter-overrides DocDBClusterIdentifier=quickbooks-hubspot-cluster

   # Build and upload Lambda ZIP
   npm run package-lambda
   aws s3 cp ./hubspot-quickbooks-backend.zip s3://<your-deployment-bucket>/<key>

   # Deploy application stack
   aws cloudformation deploy --template-file src/app.yaml --stack-name hubspot-app --capabilities CAPABILITY_NAMED_IAM --parameter-overrides LambdaDeploymentBucket=<your-deployment-bucket> LambdaS3Key=<key> DocDBClusterEndpoint=<docdb-endpoint> DocDBClusterIdentifier=<docdb-identifier> StageName=prod QuickBooksEnvironment=production
   ```

   Outputs and useful stack exports

   - `src/app.yaml` exposes `ApiEndpoint` (HTTP API URL) and `LambdaFunctionArn`.
   - `src/network.yaml` exports VPC and subnet ids (`hsqbo:network:PrivateSubnet1Id` etc.).
   - `src/data-create.yaml` exports the DocumentDB cluster endpoint and identifier.
   - `src/secrets-only.yaml` exposes the secret names to reference in other tooling or templates.

   Security and operational considerations

   - Secrets: templates create Secrets Manager entries but default the secret values to placeholders. Update secrets immediately after creation and consider scoping the Lambda IAM role to specific secret ARNs (instead of `*`).
   - IAM: review `app.yaml` IAM inline policies and ensure least-privilege is applied for production deployment.
   - Backups & retention: DocumentDB cluster is created with a retention period (7 days in the template). Adjust according to your RPO/RTO needs.
   - VPC egress: Lambdas in private subnets require a NAT gateway (created by the network stack) to reach external services (QuickBooks, HubSpot, Secrets Manager). Ensure NAT capacity and cost considerations are accounted for.

   CI/CD and automation

   - The repository contains npm scripts to build and package the Lambda. There is also a placeholder `cloudformation.yaml` pointing to the modular templates and a GitHub Actions workflow in `.github/workflows/` (if present) can be used to automate build & deploy. Prefer deploying via a CI pipeline using credentials with least privilege.


   ## Troubleshooting

   - OAuth invalid_client during token exchange usually means client credentials are wrong or rotated. The app attempts a credentials reload once.
   - If invoices fail with QuickBooks validation errors, check the debug logs — the full invoice payload is logged on failure.

   ## License

   - MIT (see LICENSE.md)