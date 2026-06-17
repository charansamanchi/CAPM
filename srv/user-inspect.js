const cds = require('@sap/cds')

module.exports = cds.service.impl(function () {

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

    function getXSUAAUrl() {
        if (process.env.VCAP_SERVICES) {
            const vcap  = JSON.parse(process.env.VCAP_SERVICES)
            const xsuaa = vcap.xsuaa?.[0]?.credentials
            if (xsuaa?.url) return xsuaa.url
        }
        const creds = cds.env.requires?.auth?.credentials
        if (creds?.url) return creds.url
        throw new Error('XSUAA URL not found — bind the xsuaa service or add default-env.json')
    }

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

    // ─── UserAttributes READ ──────────────────────────────────────────────────
    this.on('READ', 'UserAttributes', async (req) => {
        try {
            const authHeader = getAuthHeader(req)
            const info    = await fetchUserInfo(authHeader)
            const xsAttrs = info['xs.user.attributes'] ?? {}
            const extAttr = info.ext_attr ?? {}
            const iasAttrs = info.ias_user_attributes ?? extAttr.ias_user_attributes ?? {}
            const all     = { ...xsAttrs, ...iasAttrs }

            const jwt = authHeader.startsWith('Bearer ') ? decodeJWT(authHeader.slice(7)) : null
            const jwtSysAttrs = jwt?.['xs.system.attributes'] ?? {}
            const groups   = jwtSysAttrs['xs.saml.groups'] ?? null
            const userUuid = jwt?.user_uuid ?? info.user_uuid ?? info.sub ?? req.user.id

            // CAP req.user.attr — populated from xs.user.attributes in the JWT
            // once IAS maps SAML attributes (ANID, email, Permissions) to XSUAA
            const userAttr = req.user?.attr ?? {}

            const jwtXsAttrs = jwt?.['xs.user.attributes'] ?? {}
            const isANUser = (jwt?.origin === 'sap.custom') ||
                             (groups || []).some(g => g.toLowerCase().includes('ariba'))
            const anid = userAttr.ANID?.[0] ?? userAttr.ANID ??
                         all.ANID ?? all.supplierANID ?? all.SupplierANID ??
                         all.ariba_network_id ??
                         jwtXsAttrs.ANID ?? jwtXsAttrs.supplierANID ??
                         (isANUser ? jwt?.user_name : null) ?? null

            const permissions = userAttr.Permissions?.[0] ?? userAttr.Permissions ?? null

            // Prefer real email from req.user.attr (mapped from ContactEmail in SAML)
            // over the dummy "<userid>@user.from.sap.custom.cf" from /userinfo
            const email = userAttr.email?.[0] ?? userAttr.email ?? info.email ?? null

            const row = {
                user_uuid:           userUuid,
                user_id:             info.user_id             ?? null,
                sub:                 info.sub                 ?? null,
                sub_idp:             info.sub_idp             ?? null,
                email:               email,
                given_name:          info.given_name          ?? null,
                family_name:         info.family_name         ?? null,
                origin:              info.origin              ?? null,
                anid:                anid,
                xs_user_attributes:  JSON.stringify({ ...xsAttrs, ...userAttr }, null, 2),
                ias_user_attributes: JSON.stringify(iasAttrs, null, 2),
                ext_attr:            JSON.stringify(extAttr,  null, 2),
                ias_groups:          JSON.stringify(groups,   null, 2),
                raw_userinfo:        JSON.stringify(info,     null, 2),
                raw_token_claims:    JSON.stringify(jwt,      null, 2),
                scim_user:           JSON.stringify({ permissions, userAttr }, null, 2),
                cap_user_attrs:      JSON.stringify(userAttr, null, 2),
                permissions:         permissions,
            }
            const result = [row]
            result.$count = 1
            return result
        } catch (e) {
            req.error(500, e.message)
        }
    })
})
