/**
 * Service to inspect current user attributes from IAS/XSUAA.
 * All functions require an authenticated user (Bearer token from XSUAA).
 */
@requires: 'authenticated-user'
service UserInspectService {

    /**
     * Calls XSUAA /userinfo endpoint with the current user's token.
     * This is the standard OIDC API — returns all claims XSUAA exposes for the user.
     */
    function getUserInfo()             returns String;

    /**
     * Returns the full decoded JWT token claims as-is (no API call, local decode).
     */
    function getTokenClaims()          returns String;

    /**
     * Returns CAP user object: id, roles, attr.
     */
    function getCAPUser()              returns String;

    /**
     * Returns IAS-specific attributes from /userinfo response:
     * xs.user.attributes, ext_attr, ias_user_attributes, origin, user_uuid.
     */
    function getIASAttributes()        returns String;

    /**
     * Returns Ariba Network supplier attributes from /userinfo response.
     */
    function getANSupplierAttributes() returns String;
}
