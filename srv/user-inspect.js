const cds = require('@sap/cds')

module.exports = cds.service.impl(function () {

    // ─── helpers ──────────────────────────────────────────────────────────────────

    function getAuthHeader(req) {
        return req.headers?.authorization
            || req._.req?.headers?.authorization
            || ''
    }

    function decodeJWT(token) {
        try {
            const payload = token.split('.')[1]
            return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
        } catch {
            return null
        }
    }

    // Reads the XSUAA URL from the service binding (VCAP_SERVICES in CF,
    // or cds.env for local runs with a default-env.json / service key).
    function getXSUAAUrl() {
        if (process.env.VCAP_SERVICES) {
            const vcap  = JSON.parse(process.env.VCAP_SERVICES)
            const xsuaa = vcap.xsuaa?.[0]?.credentials
            if (xsuaa?.url) return xsuaa.url
        }
        // CAP env fallback (works with default-env.json or cds bind)
        const creds = cds.env.requires?.auth?.credentials
        if (creds?.url) return creds.url

        throw new Error('XSUAA URL not found — bind the xsuaa service or add default-env.json')
    }

    // Standard OIDC call: GET {xsuaa_url} with the user's Bearer token.
    // This is the authoritative source — XSUAA validates the/userinfo token and returns
    // all configured user attributes including those propagated from IAS.
    async function fetchUserInfo(authHeader) {
        if (!authHeader) throw new Error('No Authorization header in request')
        const url = `${getXSUAAUrl()}/userinfo`
        const res = await fetch(url, { headers: { Authorization: authHeader } })
        if (!res.ok) {
            const body = await res.text()
            throw new Error(`XSUAA /userinfo returned ${res.status}: ${body}`)
        }
        return res.json()
    }

    // ─── getUserInfo ──────────────────────────────────────────────────────────────
    // Direct call to XSUAA /userinfo — use this as the primary inspection endpoint.
    this.on('getUserInfo', async (req) => {
        try {
            const info = await fetchUserInfo(getAuthHeader(req))
            return JSON.stringify(info, null, 2)
        } catch (e) {
            return JSON.stringify({ error: e.message }, null, 2)
        }
    })

    // ─── getTokenClaims ───────────────────────────────────────────────────────────
    // Local JWT decode (no network call). Useful to see raw internal XSUAA claims
    // like zid, serviceinstanceid that /userinfo does not expose.
    this.on('getTokenClaims', (req) => {
        const auth = getAuthHeader(req)
        if (!auth.startsWith('Bearer ')) return JSON.stringify({ error: 'No Bearer token' }, null, 2)
        const claims = decodeJWT(auth.slice(7))
        return JSON.stringify(claims ?? { error: 'Could not decode JWT' }, null, 2)
    })

    // ─── getCAPUser ───────────────────────────────────────────────────────────────
    this.on('getCAPUser', (req) => {
        const u = req.user
        return JSON.stringify({
            id:     u.id,
            locale: u.locale,
            tenant: u.tenant,
            attr:   u.attr,
            roles:  [...(u._roles ?? [])],
        }, null, 2)
    })

    // ─── getIASAttributes ─────────────────────────────────────────────────────────
    // Uses /userinfo as the source of truth for IAS-propagated attributes.
    this.on('getIASAttributes', async (req) => {
        try {
            const info = await fetchUserInfo(getAuthHeader(req))

            return JSON.stringify({
                // Standard OIDC identity
                sub:            info.sub,
                user_uuid:      info.user_uuid,
                origin:         info.origin,       // IAS tenant alias or corporate IdP
                email:          info.email,
                given_name:     info.given_name,
                family_name:    info.family_name,

                // IAS custom schema attributes (configured in IAS → forwarded via XSUAA trust)
                xs_user_attributes:  info['xs.user.attributes']  ?? {},
                ext_attr:            info.ext_attr                ?? {},
                ias_user_attributes: info.ias_user_attributes
                    ?? info.ext_attr?.ias_user_attributes
                    ?? {},
            }, null, 2)
        } catch (e) {
            return JSON.stringify({ error: e.message }, null, 2)
        }
    })

    // ─── getANSupplierAttributes ──────────────────────────────────────────────────
    // Uses /userinfo to check for Ariba Network supplier signals.
    this.on('getANSupplierAttributes', async (req) => {
        try {
            const info       = await fetchUserInfo(getAuthHeader(req))
            const xsAttrs    = info['xs.user.attributes']       ?? {}
            const extAttr    = info.ext_attr                    ?? {}
            const iasAttrs   = info.ias_user_attributes
                ?? extAttr.ias_user_attributes
                ?? {}
            const all        = { ...xsAttrs, ...iasAttrs }
            const anid       = all.ANID ?? all.supplierANID ?? all.SupplierANID ?? all.ariba_network_id

            return JSON.stringify({
                isANSupplier: isLikelyANSupplier(info.origin, all),

                ANID:             anid,
                companyId:        all.companyId        ?? all.CompanyId,
                vendorId:         all.vendorId         ?? all.VendorId,
                businessPartner:  all.businessPartner,
                companyCode:      all.companyCode,

                // Identity signals
                origin:      info.origin,
                user_uuid:   info.user_uuid,
                email:       info.email,

                // Full dumps so you can discover the real attribute names in your env
                _raw_xs_user_attributes:  xsAttrs,
                _raw_ias_user_attributes: iasAttrs,
                _raw_ext_attr:            extAttr,
            }, null, 2)
        } catch (e) {
            return JSON.stringify({ error: e.message }, null, 2)
        }
    })

    // ─── UserAttributes READ ──────────────────────────────────────────────────
    this.on('READ', 'UserAttributes', async (req) => {
        try {
            const authHeader = getAuthHeader(req)
            const info    = await fetchUserInfo(authHeader)
            const xsAttrs = info['xs.user.attributes'] ?? {}
            const extAttr = info.ext_attr ?? {}
            const iasAttrs = info.ias_user_attributes ?? extAttr.ias_user_attributes ?? {}
            const all     = { ...xsAttrs, ...iasAttrs }

            // Decode JWT to read xs.system.attributes which /userinfo does not expose
            const jwt = authHeader.startsWith('Bearer ') ? decodeJWT(authHeader.slice(7)) : null
            const jwtSysAttrs = jwt?.['xs.system.attributes'] ?? {}
            const groups   = jwtSysAttrs['xs.saml.groups'] ?? null
            const userUuid = jwt?.user_uuid ?? info.user_uuid ?? info.sub ?? req.user.id

            const row = {
                user_uuid:           userUuid,
                user_id:             info.user_id             ?? null,
                sub:                 info.sub                 ?? null,
                sub_idp:             info.sub_idp             ?? null,
                email:               info.email               ?? null,
                given_name:          info.given_name          ?? null,
                family_name:         info.family_name         ?? null,
                origin:              info.origin              ?? null,
                anid:                all.ANID ?? all.supplierANID ?? all.SupplierANID ?? all.ariba_network_id ?? null,
                xs_user_attributes:  JSON.stringify(xsAttrs,  null, 2),
                ias_user_attributes: JSON.stringify(iasAttrs, null, 2),
                ext_attr:            JSON.stringify(extAttr,  null, 2),
                ias_groups:          JSON.stringify(groups,   null, 2),
                raw_userinfo:        JSON.stringify(info,     null, 2),
                raw_token_claims:    JSON.stringify(jwt,      null, 2),
            }
            // console.log('[UserAttributes] returning row with user_uuid:', row.user_uuid)
            const result = [row]
            result.$count = 1
            return result
        } catch (e) {
            // console.error('[UserAttributes] ERROR:', e.message)
            req.error(500, e.message)
        }
    })
})

function isLikelyANSupplier(origin = '', attrs = {}) {
    const o = origin.toLowerCase()
    return (
        o.includes('ariba') || o.includes('an-') ||
        !!(attrs.ANID || attrs.supplierANID || attrs.SupplierANID ||
           attrs.ariba_network_id || attrs.companyId)
    )
}
