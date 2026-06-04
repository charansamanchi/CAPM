sap.ui.define(["sap/fe/core/AppComponent"], function (AppComponent) {
    "use strict";
    debugger; // BP1: module loaded
    var Component = AppComponent.extend("com.capm.userattrs.Component", {
        metadata: { manifest: "json" },
        init: function () {
            debugger; // BP2: init called
            AppComponent.prototype.init.apply(this, arguments);
            debugger; // BP3: after super init
        }
    });
    //debugger; // BP4: class defined
    return Component;
});
