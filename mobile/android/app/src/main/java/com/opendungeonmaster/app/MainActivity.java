package com.opendungeonmaster.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The phone-hosted world plugin lives in this app rather than a
        // package, so it registers here before the bridge loads the page.
        registerPlugin(LocalWorldPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
