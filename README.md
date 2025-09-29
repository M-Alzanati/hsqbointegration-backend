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

   ## AWS infrastructure (CloudFormation) — analysis

   This project ships modular CloudFormation templates under `src/` that together form the AWS infrastructure for the service. The primary templates and their responsibilities:

   - `src/network.yaml` — VPC and networking resources (VPC, private/public subnets, NAT, route tables, and a `LambdaSecurityGroup`). It exports values like `hsqbo:network:PrivateSubnet1Id`, `hsqbo:network:PrivateSubnet2Id`, and `hsqbo:network:LambdaSecurityGroupId` that other stacks import.
   - `src/secrets-only.yaml` — Creates Secrets Manager secrets used by the app: `docdb/password`, `service/api/key`, `quickbooks/client/id`, `quickbooks/client/secret`, and `hubspot/api/key`.
   - `src/data-create.yaml` — Deploys DocumentDB (Amazon DocumentDB / MongoDB compatible) cluster, subnet group and security group allowing access from the Lambda security group. Outputs include the cluster endpoint and identifier.
   - `src/bucket-only.yaml` — Creates a private S3 bucket used for Lambda deployment artifacts (zip uploads).
   - `src/bastion.yaml` — (Optional) Bastion host to access DocumentDB for troubleshooting or one-off admin tasks (supports SSM and optional EIP).
   - `src/app.yaml` — The application stack. Creates IAM roles, Lambda functions (`HubspotQuickbookApiLambda`, `HubspotQuickbookAdminInvalidate`), API Gateway (HTTP API), CloudWatch LogGroups and wiring for environment variables. Lambda functions are configured to run inside the private subnets and reference the exported `LambdaSecurityGroupId` and subnet ids.

   Key architecture notes:

   - Lambda functions run inside the VPC private subnets so they can access DocumentDB; the `LambdaSecurityGroup` controls network egress and DocumentDB security group permits traffic from the Lambda security group.
   - OAuth tokens and sensitive values are stored in MongoDB (DocumentDB) and Secrets Manager (client id/secret and service API key). The Lambda role grants `secretsmanager:GetSecretValue` so the runtime can fetch secrets.
   - API Gateway (HTTP API) fronts the Lambdas and auto-deploys a stage (default `prod` in templates). Access logs are written to CloudWatch Log Groups created by the `app.yaml` template.
   - A private S3 bucket is expected for deployment artifacts ZIPs; build scripts in `package.json` create the ZIP and there are npm scripts to upload/update the Lambda.

   Deployment order and recommendations

   1. Deploy `src/network.yaml` first (or import your existing VPC by setting `UseExistingVpc=true` and providing `ExistingVpcId` and subnet ids). This creates exports other stacks rely on.
   2. Deploy `src/secrets-only.yaml` to create required Secrets Manager secrets. You can fill their values from the AWS Console or via CLI after creation.
   3. Deploy `src/bucket-only.yaml` (or create your own S3 bucket) to host the Lambda zip.
   4. Deploy `src/data-create.yaml` to provision DocumentDB. It requires the VPC/subnets and will create a security group that allows access from the Lambda SG.
   5. Upload your Lambda ZIP (created by `npm run package-lambda`) to the deployment S3 bucket.
   6. Deploy `src/app.yaml`, passing parameters like `LambdaDeploymentBucket`, `LambdaS3Key`, `DocDBClusterEndpoint`, `DocDBClusterIdentifier`, `DocDBMasterUsername`, `StageName`, and `QuickBooksEnvironment`.

   Sample CloudFormation deploy commands (replace placeholders):

   ```powershell
   # 1) Network
   aws cloudformation deploy --template-file src/network.yaml --stack-name hubspot-network --capabilities CAPABILITY_NAMED_IAM --parameter-overrides VpcCidr=10.0.0.0/16

   # 2) Secrets (creates Secrets Manager entries)
   aws cloudformation deploy --template-file src/secrets-only.yaml --stack-name hubspot-secrets --capabilities CAPABILITY_NAMED_IAM

   # 3) Bucket
   aws cloudformation deploy --template-file src/bucket-only.yaml --stack-name hubspot-bucket --capabilities CAPABILITY_NAMED_IAM

   # 4) Data (DocumentDB)
   aws cloudformation deploy --template-file src/data-create.yaml --stack-name hubspot-docdb --capabilities CAPABILITY_NAMED_IAM --parameter-overrides DocDBClusterIdentifier=quickbooks-hubspot-cluster

   # 5) Upload Lambda zip to the bucket (after npm run package-lambda)
   aws s3 cp ./hubspot-quickbooks-backend.zip s3://<your-deployment-bucket>/<key>

   # 6) App (Lambda + API Gateway)
   aws cloudformation deploy --template-file src/app.yaml --stack-name hubspot-app --capabilities CAPABILITY_NAMED_IAM --parameter-overrides LambdaDeploymentBucket=<your-deployment-bucket> LambdaS3Key=<key> DocDBClusterEndpoint=<docdb-endpoint> DocDBClusterIdentifier=<docdb-identifier> StageName=prod QuickBooksEnvironment=production
   ```

   Permissions & IAM notes

   - The `app.yaml` Lambda role includes the managed policies `AWSLambdaBasicExecutionRole` and `AWSLambdaVPCAccessExecutionRole` and is granted `secretsmanager:GetSecretValue` in-line. If you lock down secrets to specific ARNs you should update the policy to list those secret ARNs rather than `*`.
   - The CloudFormation templates create resources with sensible defaults, but review and apply least-privilege changes before using in production.

   Networking & connectivity

   - DocumentDB is created in private subnets and secured by a Security Group which only allows access from the Lambda security group (and optionally a bastion SG). If you need to connect from your desktop, create a bastion with `src/bastion.yaml` and restrict SSH/SSM to your IP.
   - Because Lambdas run in private subnets, ensure there is a NAT gateway (network stack creates one by default when creating the VPC) for outbound internet access (used to call QuickBooks, HubSpot, and AWS Secrets Manager).

   Outputs to expect

   - `app.yaml` exports `ApiEndpoint` (the HTTP API URL) and `LambdaFunctionArn` for the API Lambda.
   - `network.yaml`, `data-create.yaml`, and `secrets-only.yaml` provide outputs you will use when wiring parameters for later stacks.

   If you want, I can add a small helper script (`scripts/list-taxcodes.js`) that uses stored credentials to list TaxCode Name/Id pairs from QuickBooks (helpful to copy the numeric GST 5% id). I can also add a sample `deploy.sh` or GitHub Actions workflow notes to the README. Which would you prefer?

   ## Troubleshooting

   - OAuth invalid_client during token exchange usually means client credentials are wrong or rotated. The app attempts a credentials reload once.
   - If invoices fail with QuickBooks validation errors, check the debug logs — the full invoice payload is logged on failure.

   ---

   If you want, I can also add a small helper script in `scripts/` that lists tax codes for a configured QuickBooks company and prints Name/Id pairs to make it trivial to pick the GST 5% id. Would you like that?
