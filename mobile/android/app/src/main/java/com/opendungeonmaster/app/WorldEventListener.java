package com.opendungeonmaster.app;

/**
 * How the native world and tunnel tell the plugin, and through it the
 * bridge, about changes they made on their own: the server died, cloudflared
 * exited, a stop finished. The plugin forwards each call as one
 * <code>worldEvent</code> with <code>{ source, state, message? }</code>.
 * Sources are "world" and "tunnel"; states are "running", "stopped" and
 * "error"; the message is a sentence for people or empty.
 */
public interface WorldEventListener {
    void onWorldEvent(String source, String state, String message);
}
