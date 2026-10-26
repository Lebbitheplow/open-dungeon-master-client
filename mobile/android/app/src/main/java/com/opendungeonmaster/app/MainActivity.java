package com.opendungeonmaster.app;

import android.graphics.Color;
import android.os.Bundle;
import android.view.ViewGroup;
import androidx.activity.EdgeToEdge;
import androidx.activity.SystemBarStyle;
import androidx.core.graphics.Insets;
import androidx.core.splashscreen.SplashScreen;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // The launch theme's splash (the d20 on the night color), then the
        // app's own theme. Without this the activity kept the launch theme
        // for its whole life.
        SplashScreen.installSplashScreen(this);
        // Edge to edge on every Android version, not only the 15+ ones that
        // enforce it: the window draws behind transparent system bars with
        // light icons on them (the app is night-only), and the margins set
        // below keep the page between the bars, so what
        // shows through them is the window background, the same night color
        // as the page. This is the replacement for the statusBarColor and
        // navigationBarColor theme attributes Android 15 deprecated, and it
        // has to run before the bridge sets the content view.
        EdgeToEdge.enable(this, SystemBarStyle.dark(Color.TRANSPARENT), SystemBarStyle.dark(Color.TRANSPARENT));
        // The phone-hosted world plugin, the streaming download plugin and
        // the speech recognizer live in this app rather than a package, so
        // they register here before the bridge loads the page.
        registerPlugin(LocalWorldPlugin.class);
        registerPlugin(DownloadPlugin.class);
        registerPlugin(DictationPlugin.class);
        registerPlugin(SecretStorePlugin.class);
        super.onCreate(savedInstanceState);
        // The page keeps clear of the system bars and of the keyboard.
        // Capacitor's own edge-to-edge margins count only the bars, and
        // drawing edge to edge stops adjustResize from shrinking the window,
        // so the keyboard covered every field in the lower half of the screen
        // (the first-run name, the table's message box). While the keyboard
        // is up its height replaces the navigation bar's as the bottom margin,
        // and the page lays out above it as it did before edge to edge.
        ViewCompat.setOnApplyWindowInsetsListener(getBridge().getWebView(), (view, windowInsets) -> {
            Insets bars = windowInsets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout());
            Insets keyboard = windowInsets.getInsets(WindowInsetsCompat.Type.ime());
            ViewGroup.MarginLayoutParams margins = (ViewGroup.MarginLayoutParams) view.getLayoutParams();
            margins.leftMargin = bars.left;
            margins.topMargin = bars.top;
            margins.rightMargin = bars.right;
            margins.bottomMargin = Math.max(bars.bottom, keyboard.bottom);
            view.setLayoutParams(margins);
            return WindowInsetsCompat.CONSUMED;
        });
    }
}
