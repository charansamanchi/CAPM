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

    // Standard OIDC call: GET {xsuaa_url}/userinfo with the user's Bearer token.
    // This is the authoritative source — XSUAA validates the token and returns
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

            return JSON.stringify({
                isANSupplier: isLikelyANSupplier(info.origin, all),

                // Well-known AN/supplier attribute names — actual names depend on
                // your IAS custom schema mapping. Use _raw_* below to find real names.
                supplierANID:     all.supplierANID     ?? all.SupplierANID,
                companyId:        all.companyId        ?? all.CompanyId,
                vendorId:         all.vendorId         ?? all.VendorId,
                businessPartner:  all.businessPartner,
                ariba_network_id: all.ariba_network_id,
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
})

function isLikelyANSupplier(origin = '', attrs = {}) {
    const o = origin.toLowerCase()
    return (
        o.includes('ariba') || o.includes('an-') ||
        !!(attrs.supplierANID || attrs.SupplierANID ||
           attrs.ariba_network_id || attrs.companyId)
    )
}
