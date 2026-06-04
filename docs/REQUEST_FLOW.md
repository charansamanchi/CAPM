# Request Flow: User Attribute Inspector

## Overview

```
Browser
  │
  ▼
CAPM Approuter  (CF app: CAPM)
  │   xs-app.json routes every request
  │
  ├─► /user-inspect-ui/**  ──► localDir: resources/  (static files, served from approuter filesystem)
  │
  └─► /odata/v4/**         ──► destination: srv-api   (proxied to CAPM-srv)
                                                            │
                                                            ▼
                                                    CAPM-srv  (CAP Node.js)
                                                      │  cds-serve
                                                      │
                                                      └─► XSUAA /userinfo
                                                          IAS (via JWT token)
```

---

## Step-by-step

### 1. Browser hits the URL

```
https://development-development-capm.cfapps.sa30.hana.ondemand.com/user-inspect-ui/index.html
```

The request arrives at the **CAPM approuter** (`app/router/`), which is a Node.js app running
`@sap/approuter`.

---

### 2. Approuter evaluates xs-app.json routes

`app/router/xs-app.json` is read top-to-bottom. The first matching `source` pattern wins:

| Route | Pattern | Handled by |
|---|---|---|
| 1 | `^/user-api(.*)` | `sap-approuter-userapi` service |
| 2 | `^/user-inspect-ui/(.*)$` | `localDir: resources` — static files from approuter filesystem |
| 3 | `^/(.*)$` | `destination: srv-api` — proxied to CAPM-srv |

The request `/user-inspect-ui/index.html` matches **Route 2**.

`authenticationType: xsuaa` means: if the user has no session cookie yet, redirect to XSUAA/IAS
login before serving the file.

---

### 3. XSUAA / IAS login (first visit only)

If no session exists the approuter returns a client-side redirect to:
```
https://sao-corp-dev-9bgapsnr.authentication.sa30.hana.ondemand.com/oauth/authorize?...
```

The user logs in via IAS SSO. XSUAA issues a JWT access token and sets a session cookie on the
approuter domain. All subsequent requests in the same browser session skip this step.

---

### 4. index.html is served

The approuter serves the file directly from its own filesystem:
```
/home/vcap/app/resources/user-inspect-ui/index.html
```

This file was packaged into the approuter during `cf push CAPM -p app/router`. It is **not** fetched
from the HTML5 Application Repository — it lives inside the approuter droplet.

The page renders with a "Loading…" placeholder and immediately runs the JavaScript below.

---

### 5. Browser fetch: OData call

The JavaScript in `index.html` makes one fetch:

```js
fetch('/odata/v4/user-inspect/UserAttributes?$format=json')
```

This is a relative URL — the browser sends it to the same origin (the approuter).

---

### 6. Approuter proxies to CAPM-srv

The path `/odata/v4/...` matches **Route 3** (`^/(.*)$`).

The approuter:
- Forwards the request to `https://development-development-capm-srv.cfapps.sa30.hana.ondemand.com`
- Injects the user's XSUAA Bearer token (`forwardAuthToken: true` in the destination config)
- Adds CSRF protection for non-GET requests

The `srv-api` destination URL is injected at deploy time via the `provides/requires` block in
`mta.yaml`. The approuter has no hardcoded knowledge of `user-inspect.js` — it simply forwards
the full path unchanged to whatever URL `srv-api` resolves to.

---

### 7. CAP routes the request to user-inspect.js

CAPM-srv runs `cds-serve`, which at startup reads `gen/srv/srv/csn.json` — the compiled output
of `srv/user-inspect.cds`. This tells the CAP runtime two things:
21
1. **Where to mount the service**: `UserInspectService` → `/odata/v4/user-inspect/`
2. **Which JS file implements it**: `srv/user-inspect.js`

So when the request arrives at `/odata/v4/user-inspect/UserAttributes`, CAP matches it to the
`UserInspectService` mount point and calls the `READ UserAttributes` handler in `user-inspect.js`.

```
incoming:  GET /odata/v4/user-inspect/UserAttributes
                          │
                   csn.json says:
                   UserInspectService mounted at /odata/v4/user-inspect/
                   impl: srv/user-inspect.js
                          │
                          ▼
              user-inspect.js → this.on('READ', 'UserAttributes', ...)
```

The `READ` handler:

1. Extracts the Bearer token from the `Authorization` header
2. Calls `GET {xsuaa_url}/userinfo` with the token → returns claims XSUAA exposes (`email`,
   `given_name`, `user_id`, `sub_idp`, etc.)
3. Locally decodes the JWT (no network call) → reads `xs.system.attributes.xs.saml.groups`
   (IAS Company Groups) and `user_uuid`
4. Builds a single-row response combining both sources
5. Returns OData JSON

---

### 8. Browser renders the table

The fetch resolves with the OData response:
```json
{ "value": [{ "user_uuid": "...", "email": "...", "ias_groups": "[...]", ... }] }
```

The JavaScript builds two HTML tables and injects them into `<div id="output">`:
- **Identity table** — scalar fields (UUID, email, name, origin, ANID)
- **Attribute bags table** — JSON dumps of `xs.user.attributes`, `ias_user_attributes`,
  `ext_attr`, IAS Groups, raw `/userinfo`, raw JWT claims

---

## Key files

| File | Role |
|---|---|
| `app/router/xs-app.json` | **Active** — approuter routing rules, evaluated on every request |
| `app/router/resources/user-inspect-ui/index.html` | **Active** — the UI, served as a static file, makes the OData fetch |
| `srv/user-inspect.cds` | **Active** — OData service definition; `cds build` compiles this to `gen/srv/srv/csn.json` which tells CAP where to mount the service and which JS implements it |
| `srv/user-inspect.js` | **Active** — service implementation, fetches XSUAA /userinfo, decodes JWT |
| `xs-security.json` | **Active** — XSUAA app descriptor, defines scopes and role collections |
| `app/user-inspect-ui/webapp/manifest.json` | **Unused** — was the Fiori Elements app descriptor; only needed by the SAPUI5 Component framework which is no longer used |
| `app/user-inspect-ui/webapp/xs-app.json` | **Unused** — was the routing config for when the app was served from the HTML5 Application Repository; has no effect in the current `localDir` setup |
| `app/user-inspect-ui/webapp/Component.js` | **Unused** — Fiori Elements app component; no longer loaded since `index.html` is plain HTML with no SAPUI5 bootstrap |

---

## Why two data sources?

| Source | What it gives you |
|---|---|
| XSUAA `/userinfo` | Claims XSUAA chose to expose: `email`, `given_name`, `user_id`, `sub_idp`, `xs.user.attributes` (custom mapped attributes from IAS) |
| JWT token (local decode) | Everything XSUAA put in the token but not `/userinfo`: `user_uuid`, `xs.system.attributes` → `xs.saml.groups` (IAS Company Groups) |

XSUAA `/userinfo` and the JWT token are not identical. Groups forwarded via SAML assertion
(`xs.saml.groups`) appear only in the token, not in `/userinfo`.



How srv-api → user-inspect.js
It doesn't know about user-inspect.js specifically. Here's the chain:


index.html fetch('/odata/v4/user-inspect/UserAttributes')
    │
    │  Route 3 in xs-app.json matches ^/(.*)$
    │  target: $1  →  passes the path as-is
    ▼
srv-api destination
    = https://development-development-capm-srv.cfapps.sa30.hana.ondemand.com
    │
    │  Full URL becomes:
    │  https://...-capm-srv.../odata/v4/user-inspect/UserAttributes
    ▼
CAP runtime (cds-serve) on CAPM-srv
    │
    │  At startup, CDS scanned srv/csn.json and found:
    │  "UserInspectService" → mount at /odata/v4/user-inspect/
    │  implementation → srv/user-inspect.js
    ▼
user-inspect.js  READ handler fires
The key is srv/csn.json — generated by cds build from your .cds file. It tells the CAP runtime:

where to mount the service (/odata/v4/user-inspect/)
which JS file implements it (user-inspect.js)
The approuter is just a dumb proxy for /odata/v4/ — it forwards the full path unchanged to the srv URL. CAP on the other end owns the routing from there.