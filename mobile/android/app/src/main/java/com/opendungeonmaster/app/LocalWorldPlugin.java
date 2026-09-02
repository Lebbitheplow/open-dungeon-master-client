package com.opendungeonmaster.app;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.IOException;
import java.util.Iterator;
import org.json.JSONObject;

/**
 * The bridge's window into the device-hosted world: start it (the Node
 * child process), stop it, read its status and the tail of its log; and the
 * share tunnel that puts it on the internet. Playing alone needs no
 * notification, so the world runs as a plain child of the app; hosting
 * (sharing) is what starts the foreground service, which keeps the world
 * and the tunnel alive while the host looks at other apps. Everything else
 * the shell does with the world (accounts, settings, opening it) goes over
 * plain HTTP to 127.0.0.1 like any server.
 */
@CapacitorPlugin(name = "LocalWorld")
public class LocalWorldPlugin extends Plugin {

    private static JSObject toJS(JSONObject json) {
        JSObject object = new JSObject();
        Iterator<String> keys = json.keys();
        while (keys.hasNext()) {
            String key = keys.next();
            object.put(key, json.opt(key));
        }
        return object;
    }

    private WorldRuntime runtime() {
        return WorldRuntime.get(getContext());
    }

    private ShareTunnel tunnel() {
        return ShareTunnel.get(getContext());
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(toJS(runtime().status()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        Thread worker = new Thread(() -> {
            try {
                runtime().start();
                call.resolve(toJS(runtime().status()));
            } catch (IOException e) {
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not start the world.");
            } catch (RuntimeException e) {
                call.reject("Could not start the world: " + e.getMessage());
            }
        }, "odm-world-start");
        worker.start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        tunnel().stop();
        WorldService.stop(getContext());
        runtime().stop();
        call.resolve(toJS(runtime().status()));
    }

    @PluginMethod
    public void log(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", runtime().tailLog(16_384));
        call.resolve(result);
    }

    // ---------- sharing ----------

    @PluginMethod
    public void shareStatus(PluginCall call) {
        call.resolve(toJS(tunnel().status()));
    }

    /**
     * Starts cloudflared: with a broker token (and the address the broker
     * promised) as a named tunnel, otherwise as a quick tunnel whose address
     * comes back in the result. Hosting begins here, so the foreground
     * service starts first and stops again if the tunnel does not come up.
     */
    @PluginMethod
    public void shareStart(PluginCall call) {
        String token = call.getString("token", "");
        String promised = call.getString("url", "");
        int port = call.getInt("port", 0);
        Thread worker = new Thread(() -> {
            try {
                WorldService.start(getContext(), "Opening a public address for your world.");
                String url;
                if (token != null && !token.isEmpty()) {
                    tunnel().startNamed(token, promised != null ? promised : "");
                    url = promised != null ? promised : "";
                } else {
                    url = tunnel().startQuick(port);
                }
                WorldService.start(getContext(), "Friends can join at " + url + " while this stays on.");
                JSObject result = new JSObject();
                result.put("url", url);
                call.resolve(result);
            } catch (IOException e) {
                WorldService.stop(getContext());
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not open a public address.");
            } catch (RuntimeException e) {
                tunnel().stop();
                WorldService.stop(getContext());
                call.reject("Could not open a public address: " + e.getMessage());
            }
        }, "odm-share-start");
        worker.start();
    }

    @PluginMethod
    public void shareStop(PluginCall call) {
        tunnel().stop();
        WorldService.stop(getContext());
        call.resolve(toJS(tunnel().status()));
    }
}
