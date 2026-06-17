/**
 * Service to inspect current user attributes from IAS/XSUAA/AN.
 * Requires an authenticated user (Bearer token from XSUAA).
 */
@requires: 'authenticated-user'
service UserInspectService {

    @readonly
    @(UI: {
        HeaderInfo: {
            TypeName:       'User Attribute',
            TypeNamePlural: 'User Attributes',
            Title:          { Value: email },
            Description:    { Value: origin }
        },
        SelectionFields: [],
        LineItem: [
            { Value: user_uuid,   Label: 'User UUID'    },
            { Value: email,       Label: 'Email'        },
            { Value: given_name,  Label: 'Given Name'   },
            { Value: family_name, Label: 'Family Name'  },
            { Value: origin,      Label: 'Origin / IdP' },
            { Value: anid,        Label: 'ANID'         }
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
            scim_user           : LargeString;
            cap_user_attrs      : LargeString;
            permissions         : LargeString;
    }
}
