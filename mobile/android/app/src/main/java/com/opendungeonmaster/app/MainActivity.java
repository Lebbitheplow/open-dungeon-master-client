package com.opendungeonmaster.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The phone-hosted world plugin and the streaming download plugin
        // live in this app rather than a package, so they register here
        // before the bridge loads the page.
        registerPlugin(LocalWorldPlugin.class);
        registerPlugin(DownloadPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
