sap.ui.define([
    "sap/ui/core/mvc/Controller",
    "sap/m/MessageBox"
], function (Controller, MessageBox) {
    "use strict";
    return Controller.extend("com.capm.userattrsv3.controller.Main", {
        onInit: function () {
            var oModel = this.getOwnerComponent().getModel();
            var oView = this.getView();
            oModel.bindList("/UserAttributes").requestContexts(0, 1).then(function (aContexts) {
                if (!aContexts.length) return;
                var oData = aContexts[0].getObject();
                var aTextFields = ["user_uuid","user_id","email","given_name","family_name","sub","sub_idp","origin","anid"];
                var aAreaFields = ["raw_token_claims","ias_groups","scim_user","cap_user_attrs","permissions"];
                aTextFields.forEach(function (sField) {
                    var oCtrl = oView.byId(sField);
                    if (oCtrl) oCtrl.setText(oData[sField] || "—");
                });
                aAreaFields.forEach(function (sField) {
                    var oCtrl = oView.byId(sField);
                    if (oCtrl) oCtrl.setValue(oData[sField] || "—");
                });
            }).catch(function (oErr) {
                MessageBox.error("Failed to load user attributes: " + oErr.message);
            });
        },
        onSignOut: function () {
            window.location.href = "/logout";
        }
    });
});
