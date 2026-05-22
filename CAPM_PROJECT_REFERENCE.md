# CAPM Project Reference — User Inspect Service

> CAP application on SAP BTP Cloud Foundry to inspect IAS/XSUAA user attributes,
> including Ariba Network (AN) supplier attributes.

---

## Table of Contents

1. [Project Purpose](#1-project-purpose)
2. [Architecture Overview](#2-architecture-overview)
3. [Authentication & Token Flow](#3-authentication--token-flow)
4. [IAS Attribute Propagation Flow](#4-ias-attribute-propagation-flow)
5. [Ariba Network Supplier Flow](#5-ariba-network-supplier-flow)
6. [Project Structure](#6-project-structure)
7. [Key Files & What They Do](#7-key-files--what-they-do)
8. [OData API Reference](#8-odata-api-reference)
9. [Fiori UI (user-inspect-ui)](#9-fiori-ui-user-inspect-ui)
10. [MTA Deployment Architecture](#10-mta-deployment-architecture)
11. [Build & Deploy Steps](#11-build--deploy-steps)
12. [Troubleshooting Log](#12-troubleshooting-log)
13. [Key Issues & Resolution Story](#13-key-issues--resolution-story)
14. [Environment & Tools](#14-environment--tools)

---

## 1. Project Purpose

- Inspect **who is logged in** after authenticating through XSUAA / IAS
- See all **IAS-propagated attributes** (`xs.user.attributes`, `ext_attr`, `ias_user_attributes`)
- Specifically check **Ariba Network (AN) supplier attributes** including `ANID`
- Expose a **Fiori Elements List Report** so the app appears in BTP HTML5 Applications
- All inspection via the XSUAA standard OIDC `/userinfo` endpoint (no custom token parsing)

---

## 2. Architecture Overview

```
Browser
  │
  ▼
┌─────────────────────────────────┐
│  CAPM (Approuter)               │  CF App — approuter.nodejs
│  app/router/                    │  Handles auth session, routing
│  xs-app.json routes:            │
│  • /user-api/*  → userapi svc   │
│  • /user-inspect-ui/* → html5rt │
│  • /*           → srv-api       │
└──────────────┬──────────────────┘
               │ Bearer token forwarded
               ▼
┌─────────────────────────────────┐
│  CAPM-srv (CAP Node.js)         │  CF App — nodejs
│  srv/user-inspect.cds           │  OData v4 service
│  srv/user-inspect.js            │  Service handlers
│  Mounted at: /odata/v4/user-inspect/
└──────────────┬──────────────────┘
               │ GET /userinfo (with user's Bearer token)
               ▼
┌─────────────────────────────────┐
│  XSUAA Service (CAPM-auth)      │  Managed service — xsuaa/application
│  Validates token, returns       │
│  full OIDC claims incl. IAS     │
│  propagated attributes          │
└─────────────────────────────────┘

┌─────────────────────────────────┐
│  HTML5 App Repository           │  Managed service — html5-apps-repo
│  CAPM-html5repo (app-host)      │  Stores the Fiori app zip
│  CAPM-html5repo-runtime         │  Serves it to the approuter
└─────────────────────────────────┘
```

---

## 3. Authentication & Token Flow

```
1. User accesses approuter URL
   https://development-development-capm.cfapps.sa30.hana.ondemand.com/

2. Approuter checks for session cookie → none found

3. Approuter redirects to XSUAA:
   GET {xsuaa-url}/oauth/authorize?response_type=code&client_id=...

4. XSUAA redirects to configured Identity Provider (IdP)
   → Determined by BTP Subaccount > Security > Trust Configuration

5. User enters credentials at IdP login page
   Options:
   • SAP ID Service (default — accounts.sap.com)
   • Custom IAS tenant (if configured as primary IdP)
   • IAS with AN federation (for Ariba Network suppliers)

6. IdP authenticates → returns SAML assertion to XSUAA

7. XSUAA issues JWT (access token) → redirects to approuter callback

8. Approuter stores session cookie, user is in

9. All subsequent requests to CAP backend include:
   Authorization: Bearer <jwt>

10. CAP backend calls XSUAA /userinfo with that Bearer token
    → Returns full OIDC response with IAS-propagated attributes
```

**Which IdP is shown depends on BTP Trust Configuration:**

| Setup | Login page shown |
|---|---|
| Only SAP ID Service | accounts.sap.com |
| IAS as primary IdP | Your IAS tenant login |
| IAS + AN federation | IAS login, AN suppliers use AN credentials |
| Multiple IdPs | IdP selection screen |

---

## 4. IAS Attribute Propagation Flow

IAS custom schema attributes travel through the following chain before reaching your app:

```
IAS Custom Schema
  (define custom attributes in IAS Admin > Applications > Attributes)
        │
        │ User logs in via IAS
        ▼
IAS issues assertion with custom attributes
        │
        │ SAML/OIDC federation (IAS → XSUAA trust)
        ▼
XSUAA token contains:
  • xs.user.attributes  ← IAS attributes mapped via XSUAA trust config
  • ext_attr            ← extended attributes block
  • ias_user_attributes ← direct IAS attributes (if configured)
        │
        │ CAP backend calls GET {xsuaa-url}/userinfo
        ▼
/userinfo response (full OIDC claims):
{
  "sub":                "...",
  "user_uuid":          "...",
  "email":              "user@example.com",
  "given_name":         "...",
  "family_name":        "...",
  "origin":             "IAS-tenant-alias",
  "xs.user.attributes": { "ANID": "AN01234567890", ... },
  "ext_attr":           { "ias_user_attributes": { ... }, ... },
  "ias_user_attributes":{ "ANID": "AN01234567890", ... }
}
```

**Attribute lookup priority in code:**
```javascript
const xsAttrs  = info['xs.user.attributes'] ?? {}
const extAttr  = info.ext_attr ?? {}
const iasAttrs = info.ias_user_attributes ?? extAttr.ias_user_attributes ?? {}
const all      = { ...xsAttrs, ...iasAttrs }

// ANID — IAS sends it as "ANID" key
const anid = all.ANID ?? all.supplierANID ?? all.SupplierANID ?? all.ariba_network_id
```

---

## 5. Ariba Network Supplier Flow

```
AN Supplier browser
        │
        ▼
IAS login page
  (IAS has federation configured with Ariba Network's IdP)
        │
        │ AN authenticates the supplier
        │ AN passes: ANID, companyId, vendorId, etc.
        ▼
IAS custom schema maps AN attributes → IAS user profile
        │
        ▼
IAS → XSUAA federation
  xs.user.attributes.ANID = "AN01234567890"
        │
        ▼
CAP /userinfo call → returns ANID in attributes
        │
        ▼
UserAttributes entity row:
  anid = "AN01234567890"
  origin = "<AN IdP alias>"
  xs_user_attributes = { "ANID": "AN01234567890", ... }
```

**AN Supplier detection heuristic (isLikelyANSupplier):**
```javascript
function isLikelyANSupplier(origin = '', attrs = {}) {
    const o = origin.toLowerCase()
    return (
        o.includes('ariba') || o.includes('an-') ||
        !!(attrs.ANID || attrs.supplierANID || attrs.SupplierANID ||
           attrs.ariba_network_id || attrs.companyId)
    )
}
```

---

## 6. Project Structure

```
CAPM/
├── srv/
│   ├── user-inspect.cds        ← CDS service model + UI annotations
│   └── user-inspect.js         ← Service handlers (XSUAA /userinfo calls)
├── app/
│   ├── router/
│   │   ├── package.json        ← @sap/approuter dependency
│   │   ├── xs-app.json         ← Route definitions
│   │   └── default-env.json    ← Local dev only (gitignored)
│   └── user-inspect-ui/
│       ├── webapp/
│       │   ├── manifest.json   ← Fiori app descriptor (routes, datasource)
│       │   ├── Component.js    ← extends sap/fe/core/AppComponent
│       │   ├── index.html      ← SAPUI5 bootstrap
│       │   └── i18n/
│       │       └── i18n.properties
│       ├── xs-app.json         ← App-level routes (OData + html5repo)
│       ├── package.json        ← @sap/ux-ui5-tooling + @ui5/cli
│       ├── ui5.yaml            ← Build config (no server section)
│       └── ui5-local.yaml      ← Dev server config (proxy to localhost:4004)
├── xs-security.json            ← XSUAA security descriptor
├── mta.yaml                    ← MTA build & deploy descriptor
├── package.json                ← Root — @sap/cds, cds-dk
└── .gitignore
```

---

## 7. Key Files & What They Do

### `srv/user-inspect.cds`

Defines the OData v4 service `UserInspectService`:

- **Functions** (return raw JSON strings):
  - `getUserInfo()` — full XSUAA /userinfo response
  - `getTokenClaims()` — decoded JWT payload (no network call)
  - `getCAPUser()` — CAP req.user object
  - `getIASAttributes()` — filtered IAS attribute fields
  - `getANSupplierAttributes()` — AN-specific attributes + isANSupplier flag

- **Entity** `UserAttributes` (Fiori Elements List Report):
  - Fields: `user_uuid`, `sub`, `email`, `given_name`, `family_name`, `origin`, `anid`, `xs_user_attributes`, `ias_user_attributes`, `ext_attr`
  - UI annotations: HeaderInfo, SelectionFields, LineItem, FieldGroups, Facets

### `srv/user-inspect.js`

Key helpers:
- `getAuthHeader(req)` — extracts `Authorization: Bearer ...` from request
- `getXSUAAUrl()` — reads XSUAA URL from `VCAP_SERVICES` (CF) or `cds.env` (local)
- `fetchUserInfo(authHeader)` — calls `GET {xsuaa_url}/userinfo`
- `isLikelyANSupplier(origin, attrs)` — heuristic AN supplier detection

READ handler for `UserAttributes`:
- Calls `fetchUserInfo`, extracts all attribute layers
- Returns single-row array with `$count = 1`
- Extracts `ANID` from IAS attributes (`all.ANID` primary key)

### `app/router/xs-app.json`

```json
{
  "routes": [
    { "source": "^/user-api(.*)",          "service": "sap-approuter-userapi" },
    { "source": "^/user-inspect-ui/(.*)$", "service": "html5-apps-repo-rt",
      "authenticationType": "xsuaa" },
    { "source": "^/(.*)$",                 "destination": "srv-api",
      "csrfProtection": true }
  ]
}
```

### `xs-security.json`

- Scope: `$XSAPPNAME.User`
- Role template: `User`
- Role collection: `CAPM_User` — **must be assigned to users in BTP Cockpit**
- `oauth2-configuration.credentialTypes`: binding-secret + x509

### `mta.yaml`

| Module/Resource | Type | Purpose |
|---|---|---|
| `CAPM-srv` | nodejs | CAP backend |
| `CAPM` | approuter.nodejs | Approuter + session |
| `CAPM-user-inspect-ui` | html5 | Builds Fiori app zip |
| `CAPM-html5-deployer` | nodejs (CF task) | Uploads zip to html5repo |
| `CAPM-auth` | xsuaa/application | XSUAA service instance |
| `CAPM-html5repo` | html5-apps-repo/app-host | Stores UI zip |
| `CAPM-html5repo-runtime` | html5-apps-repo/app-runtime | Serves UI to approuter |

---

## 8. OData API Reference

**Base URL (deployed):**
`https://development-development-capm.cfapps.sa30.hana.ondemand.com/odata/v4/user-inspect/`

**Base URL (local):**
`http://localhost:4004/odata/v4/user-inspect/`

| Endpoint | Description |
|---|---|
| `GET $metadata` | OData metadata — confirm UserAttributes entity |
| `GET getUserInfo()` | Full XSUAA /userinfo JSON |
| `GET getTokenClaims()` | Decoded JWT payload |
| `GET getCAPUser()` | CAP user object (id, roles, attr) |
| `GET getIASAttributes()` | IAS-filtered attributes |
| `GET getANSupplierAttributes()` | AN supplier check + ANID |
| `GET UserAttributes` | Fiori-consumable entity row |

All endpoints require `Authorization: Bearer <token>` header.

---

## 9. Fiori UI (user-inspect-ui)

**App ID:** `com.capm.userinspect`

**Deployed URL:**
`https://development-development-capm.cfapps.sa30.hana.ondemand.com/user-inspect-ui/index.html`

**Navigation:**
- Semantic object: `UserInspect`, action: `display`
- Cross-navigation inbound: `UserInspect-display`

**List Report columns:**
- User UUID, Email, Given Name, Family Name, Origin / IdP, **ANID**

**Object Page facets:**
- Identity (user_uuid, sub, email, given_name, family_name, origin, anid)
- IAS / Custom Attributes (xs_user_attributes, ias_user_attributes, ext_attr — shown as raw JSON)

**OData data source:** `/odata/v4/user-inspect/` → `UserAttributes` entity set

**Local dev:**
```bash
cd app/user-inspect-ui
npm start   # uses ui5-local.yaml, proxies /odata/v4/user-inspect to localhost:4004
```

---

## 10. MTA Deployment Architecture

```
mbt build -p cf
  │
  ├── before-all: npm ci + npx cds build --production
  │     └── generates gen/srv/ and gen/db/
  │
  ├── CAPM-srv (nodejs):    npm clean-install --production
  │     └── packages gen/srv/ → zipped to CAPM-srv.zip
  │
  ├── CAPM (approuter):     npm install --production
  │     └── packages app/router/ → zipped to CAPM.zip
  │
  ├── CAPM-user-inspect-ui (html5):  npm ci + npm run build (ui5 build --clean-dest)
  │     └── builds into dist/ → mbt zips to com.capm.userinspect.zip
  │
  └── CAPM-html5-deployer:  copies com.capm.userinspect.zip to resources/
        └── uploads to CAPM-html5repo service on deploy

cf deploy mta_archives/CAPM_1.0.0.mtar
  │
  ├── Creates/updates CF services:
  │     CAPM-auth (xsuaa), CAPM-html5repo, CAPM-html5repo-runtime
  │
  ├── Deploys CF apps:
  │     CAPM-srv, CAPM
  │
  └── Runs content deployer:
        CAPM-html5-deployer → uploads Fiori app to html5repo
```

---

## 11. Build & Deploy Steps

### Prerequisites
```bash
# Ensure GNU Make is in PATH (required by mbt on Windows)
export PATH="$PATH:/c/Program Files (x86)/GnuWin32/bin"

# Verify tools
mbt --version
cf version
cf plugins   # should show multiapps
```

### Install multiapps CF plugin (one-time)
```bash
cf install-plugin multiapps -f
```

### CF Login
```bash
cf login -a https://api.cf.sa30.hana.ondemand.com --sso
# Select org: sao-corp-dev / space: development
```

### Build
```bash
export PATH="$PATH:/c/Program Files (x86)/GnuWin32/bin"
mbt build -p cf
# Output: mta_archives/CAPM_1.0.0.mtar
```

### Deploy
```bash
cf deploy mta_archives/CAPM_1.0.0.mtar
# Use -f flag to force-abort a stuck operation if needed:
# cf deploy mta_archives/CAPM_1.0.0.mtar -f
```

### Verify after deploy
```bash
# Check running apps
cf apps

# Check services
cf services

# Check logs
cf logs CAPM-srv --recent
cf logs CAPM --recent

# Test OData endpoint
curl -H "Authorization: Bearer <token>" \
  https://development-development-capm.cfapps.sa30.hana.ondemand.com/odata/v4/user-inspect/getUserInfo()
```

### Post-deploy: Assign role collection
In BTP Cockpit → Subaccount → Security → Role Collections → `CAPM_User`:
- Assign the users or groups that need access
- Without this, users get 403 even after successful login

---

## 12. Troubleshooting Log

| Error | Cause | Fix |
|---|---|---|
| `cf` points to Cloudflare CLI | Wrong `cf` binary in PATH | Install CF CLI from cloudfoundry/cli releases |
| `Invalid JSON content from server` | Used BAS URL as CF API | Correct API: `https://api.cf.sa30.hana.ondemand.com` |
| `make: executable file not found` | GNU Make not in PATH | `winget install GnuWin32.Make` then add to PATH |
| `'deploy' is not a registered command` | multiapps plugin missing | `cf install-plugin multiapps -f` |
| `Unrecognized field "user-attributes"` | Invalid xs-security.json fields | Replaced with `includeSystemAttributeGroups: true` |
| `CAPM-auth in create failed state` | Previous failed deploy left broken service | `cf delete-service CAPM-auth -f` then redeploy |
| Stuck MTA operation | Previous deploy hung | `cf deploy mta_archives/CAPM_1.0.0.mtar -f` |
| `Cannot GET /user-inspect/getUserInfo()` | Wrong URL — missing `/odata/v4/` prefix | Correct: `/odata/v4/user-inspect/getUserInfo()` |
| `npm ci` fails — no package-lock.json | Lock file not generated | Run `npm install` in `app/user-inspect-ui/` |
| `'ui5' is not recognized` | `@ui5/cli` not in devDependencies | Added `"@ui5/cli": "^3"` to package.json |
| `server.customMiddlewares must not be provided` | Build-time yaml can't have server config | Moved server config to `ui5-local.yaml` |
| `isLikelyANSupplier not a function` | Edit accidentally merged two lines | Re-split function definition and const line |

---

## 13. Key Issues & Resolution Story

This section documents the significant problems encountered during development and deployment, in the order they were hit, with the root cause and exact fix.

---

### Issue 1 — `npm ci` fails: no package-lock.json

**Where:** `app/user-inspect-ui/` during first `mbt build`

**Error:**
```
npm error The `npm ci` command can only install with an existing package-lock.json
```

**Root cause:** The `app/user-inspect-ui/` directory was created with `package.json` but `npm install` was never run locally, so no `package-lock.json` existed. MBT's `builder: npm-ci` calls `npm ci` which requires the lock file.

**Fix:**
```bash
cd app/user-inspect-ui
npm install    # generates package-lock.json
```
Same issue later hit `html5deployer/` — same fix.

---

### Issue 2 — `ui5` command not found during build

**Where:** `app/user-inspect-ui/` build step: `npm run build` → `ui5 build --clean-dest`

**Error:**
```
'ui5' is not recognized as an internal or external command
```

**Root cause:** `@sap/ux-ui5-tooling` provides Fiori dev middleware but does NOT bundle `@ui5/cli`. The `ui5` CLI binary comes from `@ui5/cli` which was missing from `devDependencies`.

**Fix:** Added to `app/user-inspect-ui/package.json`:
```json
"devDependencies": {
  "@sap/ux-ui5-tooling": "^1",
  "@ui5/cli": "^3"
}
```
Then `npm install` again to regenerate lock file.

---

### Issue 3 — `server.customMiddlewares must not be provided` during ui5 build

**Where:** `app/user-inspect-ui/` — `ui5 build --clean-dest`

**Error:**
```
server.customMiddlewares must not be provided in ui5.yaml when running ui5 build
```

**Root cause:** The `ui5.yaml` file contained both `builder` and `server` sections. `ui5 build` runs in build mode and rejects any `server` configuration — it's only valid for `ui5 serve`.

**Fix:** Split into two files:
- `ui5.yaml` — build config only (no `server` section)
- `ui5-local.yaml` — dev server config with `fiori-tools-proxy` and `fiori-tools-appreload` middleware

Updated `package.json` start script:
```json
"start": "fiori run --config ui5-local.yaml --open index.html"
```

---

### Issue 4 — `ui5 build` does not create a zip

**Where:** MBT `CAPM-html5-deployer` build step — looking for `dist/com.capm.userinspect.zip`

**Root cause:** `ui5 build --clean-dest` outputs individual files into `dist/` but does **not** create a zip. The HTML5 Application Repository requires a `.zip` per app. MBT's `html5` module type with `builder: zip` creates the zip, but only when zip creation is explicit.

**Fix:** Created `app/user-inspect-ui/scripts/create-zip.js` — a Node.js script called as part of the build:
```bash
# npm run build calls:
ui5 build --clean-dest && node scripts/create-zip.js
```
The script uses `PowerShell Compress-Archive` on Windows and `zip` on Linux to zip everything inside `dist/` and write the output to `dist/com.capm.userinspect.zip`.

---

### Issue 5 — HTML5 deployer: `Could not find applications in the request` (CODE 1001)

**This was the most time-consuming issue — multiple failed attempts before the root cause was understood.**

**Where:** CF deploy — CAPM-html5-deployer task `deploy-html5-content`

**Error in CF logs:**
```
[ERROR] Could not find applications in the request - CODE 1001
```

**Initial MTA config (wrong):**
```yaml
- name: CAPM-html5-deployer
  type: com.sap.application.content
  ...
  build-parameters:
    requires:
      - name: CAPM-user-inspect-ui
        artifacts: [dist/com.capm.userinspect.zip]
        target-path: resources/
```

**Attempt 1 — files at root of zip:**  
The zip contained `manifest.json`, `Component.js`, etc. at the root. `com.sap.application.content` type is supposed to upload zips from `resources/` to html5repo. Still got CODE 1001.

**Attempt 2 — files inside subdirectory in zip:**  
Tried putting files inside a `com.capm.userinspect/` folder inside the zip. Still CODE 1001.

**Root cause:** The `com.sap.application.content` MTA module type does **not** upload the zip files directly. It wraps the entire `resources/` directory (including the zip files) into **another zip** before posting to the html5-apps-repo upload API. The html5-apps-repo then receives a double-nested zip and cannot find any app manifests inside — hence CODE 1001. This is a known but poorly documented behavior.

**Fix:** Replaced `com.sap.application.content` with a **nodejs CF task** approach using `@sap/html5-app-deployer@7`:

```yaml
- name: CAPM-html5-deployer
  type: nodejs
  path: html5deployer
  parameters:
    no-route: true
    no-start: true
    memory: 256M
    disk-quota: 512M
    tasks:
      - name: deploy-html5-content
        command: npm start
        memory: 256M
        disk-quota: 512M
  requires:
    - name: CAPM-html5repo
  build-parameters:
    builder: npm-ci
    build-result: .
    requires:
      - name: CAPM-user-inspect-ui
        artifacts: [dist/com.capm.userinspect.zip]
        target-path: resources/
```

`html5deployer/package.json`:
```json
{
  "name": "capm-html5-deployer",
  "version": "1.0.0",
  "scripts": {
    "start": "node node_modules/@sap/html5-app-deployer/index.js"
  },
  "engines": { "node": "^20 || ^22" },
  "dependencies": {
    "@sap/html5-app-deployer": "^7"
  }
}
```

`@sap/html5-app-deployer` is a self-contained Node.js app that reads zip files from `resources/`, authenticates against the html5-apps-repo service binding, and uploads them directly via the html5-apps-repo Content API — no double-wrapping.

---

### Issue 6 — `@sap/html5-app-deployer@4` fails on CF (Node.js engine mismatch)

**Where:** First attempt with the nodejs deployer approach using v4

**Error:**
```
npm error Unsupported engine: @sap/html5-app-deployer@4.x requires node <=16
```

**Root cause:** `@sap/html5-app-deployer` v4 only supports Node.js ≤16. CF buildpacks use Node.js 20+.

**Fix:** Upgraded to `@sap/html5-app-deployer@^7` which supports `^18.0.0 || ^20.0.0 || ^22.0.0`.

---

### Issue 7 — mbt build running from wrong directory

**Where:** Repeated during development — mbt build triggered from wrong working directory

**Error:**
```
ERROR could not read the "C:\Users\I355335\CAPM\html5deployer\mta.yaml" file: The system cannot find the file specified.
```

**Root cause:** Shell sessions retained the CWD from previous `cd` commands (e.g., into `app/user-inspect-ui/` or `html5deployer/`). When `mbt build -p cf` was run, it looked for `mta.yaml` in the current directory rather than the project root.

**Fix:** Always run mbt from the project root:
```bash
cd /c/Users/I355335/CAPM
mbt build -p cf
```

---

### Summary: HTML5 Repo Deployment — The Core Journey

```
Attempt 1: com.sap.application.content + zip with files at root
  → CODE 1001: double-wrap by MTA type, html5repo can't find apps

Attempt 2: com.sap.application.content + zip with files in subdirectory
  → CODE 1001: same root cause, subdirectory structure irrelevant

Attempt 3: nodejs CF task + @sap/html5-app-deployer@4
  → Engine mismatch on CF (Node.js 20 vs required <=16)

Attempt 4: nodejs CF task + @sap/html5-app-deployer@7 + npm-ci builder
  → Missing package-lock.json in html5deployer/

Attempt 5: Added package-lock.json via npm install
  → SUCCESS: deploy-html5-content task ran, com.capm.userinspect uploaded
```

**Key lesson:** `com.sap.application.content` is designed for SAP-internal content deployment pipelines and double-wraps the content. For custom HTML5 apps, the `@sap/html5-app-deployer` nodejs task approach is the correct pattern.

---

## 14. Environment & Tools

| Tool | Version / Detail |
|---|---|
| SAP CAP / cds | 9.9.1 |
| Node.js (local) | v24.13.1 (approuter warns — works fine) |
| Node.js (CF buildpack) | nodejs_buildpack (v20/v22 range) |
| MBT (mbt) | 1.2.47 |
| CF CLI | latest from cloudfoundry/cli |
| CF multiapps plugin | installed via `cf install-plugin multiapps` |
| GNU Make | GnuWin32, installed via winget |
| @ui5/cli | v3.x (in user-inspect-ui devDependencies) |
| @sap/ux-ui5-tooling | ^1 |

**CF Landscape:**
- API: `https://api.cf.sa30.hana.ondemand.com`
- Org: `sao-corp-dev`
- Space: `development`
- App URL: `https://development-development-capm.cfapps.sa30.hana.ondemand.com`

**MCP Servers configured (project-scoped in .claude.json):**
- `fiori` — `npx -y @sap-ux/fiori-mcp-server`
- `cap` — `npx -y @cap-js/mcp-server`
- `adt` — `http://localhost:6655` (local ADT MCP server)

---

*Last updated: 2026-05-21 — added Key Issues & Resolution Story (section 13)*
