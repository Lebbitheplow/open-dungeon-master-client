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
 * The bridge's window into the phone-hosted world: start it (foreground
 * service plus the Node child process), stop it, read its status and the
 * tail of its log. Everything else the shell does with the world (accounts,
 * settings, opening it) goes over plain HTTP to 127.0.0.1 like any server.
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

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(toJS(runtime().status()));
    }

    @PluginMethod
    public void start(PluginCall call) {
        Thread worker = new Thread(() -> {
            try {
                WorldService.start(getContext());
                runtime().start();
                call.resolve(toJS(runtime().status()));
            } catch (IOException e) {
                WorldService.stop(getContext());
                call.reject(e.getMessage() != null ? e.getMessage() : "Could not start the world.");
            } catch (RuntimeException e) {
                WorldService.stop(getContext());
                call.reject("Could not start the world: " + e.getMessage());
            }
        }, "odm-world-start");
        worker.start();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        runtime().stop();
        WorldService.stop(getContext());
        call.resolve(toJS(runtime().status()));
    }

    @PluginMethod
    public void log(PluginCall call) {
        JSObject result = new JSObject();
        result.put("text", runtime().tailLog(16_384));
        call.resolve(result);
    }
}
