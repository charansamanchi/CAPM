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

    @readonly
    @(UI: {
        HeaderInfo: {
            TypeName:       'User Attribute',
            TypeNamePlural: 'User Attributes',
            Title:          { Value: email },
            Description:    { Value: origin }
        },
        SelectionFields: [ email, origin, given_name, anid ],
        LineItem: [
            { Value: user_uuid,   Label: 'User UUID'    },
            { Value: email,       Label: 'Email'        },
            { Value: given_name,  Label: 'Given Name'   },
            { Value: family_name, Label: 'Family Name'  },
            { Value: origin,      Label: 'Origin / IdP' },
            { Value: anid,        Label: 'ANID'         }
        ],
        FieldGroup #Identity: {
            Label: 'Identity',
            Data: [
                { Value: user_uuid   },
                { Value: sub         },
                { Value: email       },
                { Value: given_name  },
                { Value: family_name },
                { Value: origin      },
                { Value: anid        }
            ]
        },
        FieldGroup #IASAttributes: {
            Label: 'IAS / Custom Attributes',
            Data: [
                { Value: xs_user_attributes   },
                { Value: ias_user_attributes  },
                { Value: ext_attr             }
            ]
        },
        Facets: [
            { $Type: 'UI.ReferenceFacet', Label: 'Identity',       Target: '@UI.FieldGroup#Identity'      },
            { $Type: 'UI.ReferenceFacet', Label: 'IAS Attributes',  Target: '@UI.FieldGroup#IASAttributes' }
        ]
    })
    entity UserAttributes {
        key user_uuid           : String(36);
            user_id             : String;
            sub                 : String;
            sub_idp             : String;
            email               : String;
            given_name          : String;
            family_name         : String;
            origin              : String;
            anid                : String;
            xs_user_attributes  : LargeString;
            ias_user_attributes : LargeString;
            ext_attr            : LargeString;
            ias_groups          : LargeString;
            raw_userinfo        : LargeString;
            raw_token_claims    : LargeString;
    }
}
