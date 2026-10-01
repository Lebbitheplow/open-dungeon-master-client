package com.opendungeonmaster.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The phone-hosted world plugin, the streaming download plugin and
        // the speech recognizer live in this app rather than a package, so
        // they register here before the bridge loads the page.
        registerPlugin(LocalWorldPlugin.class);
        registerPlugin(DownloadPlugin.class);
        registerPlugin(DictationPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
