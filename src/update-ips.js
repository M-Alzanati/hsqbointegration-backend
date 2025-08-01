const fs = require("fs");
const path = require("path");

const templatePath = path.join(__dirname, "cloudformation.yaml");

// New IPs to allow (replace with your updated list)
const newIPs = [
  "54.174.60.0/23",
  "54.174.63.0/24",
  "52.4.191.0/24",
  "52.5.127.0/24",
  "104.18.243.108/32",
  "104.18.240.108/32",
  "104.18.241.108/32",
  "104.18.244.108/32",
  "104.18.242.108/32",
  // ...add more as needed
];

const file = fs.readFileSync(templatePath, "utf8");
const updated = file.replace(
  /(Addresses:\s*\n)([\s\S]*?)(\n\s*HubspotQuickbooksWebACL:)/,
  (_, start, oldIPs, end) => {
    const newBlock = newIPs.map((ip) => `        - ${ip}`).join("\n");
    return `${start}${newBlock}${end}`;
  }
);

fs.writeFileSync(templatePath, updated, "utf8");
console.log("IP list updated in cloudformation.yaml");
