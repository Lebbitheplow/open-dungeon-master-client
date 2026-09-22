package com.opendungeonmaster.app;

import android.content.Context;
import android.util.Log;
import java.io.BufferedReader;
import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.json.JSONObject;

/**
 * The Cloudflare tunnel that puts the device-hosted world on the public
 * internet, so friends anywhere can join and not only those on the same
 * Wi-Fi. The APK ships cloudflared as a native library (libcloudflared.so,
 * built by mobile/scripts/build-cloudflared-android.sh) and this class runs
 * it as a child process beside the world's Node server. Two modes, same as
 * the desktop shell (src/main/tunnel.ts): a named session whose token the
 * broker minted (the play-CODE address is known up front), or an anonymous
 * quick tunnel whose trycloudflare address is read from cloudflared's own
 * output. Deciding between them, waiting for DNS and reachability, and
 * telling the server its public address all happen in the bridge
 * (mobile/src/share-tunnel.ts); this side only owns the process.
 *
 * Threading: the start methods hold the monitor so two starts cannot race;
 * startQuick() can hold it for up to forty-five seconds. stop() never takes
 * it: it flips a flag and kills the child, which ends cloudflared's output
 * and so wakes the waiting start, which then reports "stopped". Both belong
 * on background threads; stop() waits up to five seconds for the exit.
 */
public final class ShareTunnel {

    private static final String TAG = "ODMShare";
    private static final long URL_WAIT_MS = 45_000;
    private static final long LOG_CAP_BYTES = 1024L * 1024;
    private static final Pattern QUICK_URL = Pattern.compile("https://[a-z0-9-]+\\.trycloudflare\\.com");

    /** Thrown when stop() cut a start short: the caller should report "stopped", not a failure. */
    public static final class StoppedException extends IOException {
        StoppedException() {
            super("Sharing was stopped before the tunnel came up.");
        }
    }

    private static ShareTunnel instance;

    public static synchronized ShareTunnel get(Context context) {
        if (instance == null) {
            instance = new ShareTunnel(context.getApplicationContext());
        }
        return instance;
    }

    private final Context app;
    private final AtomicReference<Process> process = new AtomicReference<>();
    /** Guards the hand-over of the process between a start, stop() and the exit watcher. */
    private final Object stateLock = new Object();
    private volatile boolean stopRequested;
    private volatile String url = "";
    private volatile String mode = "";
    private volatile WorldEventListener listener;
    private volatile Boolean availableCache;

    private ShareTunnel(Context app) {
        this.app = app;
    }

    /** Who hears about cloudflared exiting or a stop finishing; the plugin registers itself in load(). */
    public void setListener(WorldEventListener listener) {
        this.listener = listener;
    }

    private void emit(String eventState, String message) {
        WorldEventListener target = listener;
        if (target == null) return;
        try {
            target.onWorldEvent("tunnel", eventState, message);
        } catch (RuntimeException e) {
            Log.w(TAG, "Tunnel listener failed: " + e.getMessage());
        }
    }

    private File binary() {
        return new File(app.getApplicationInfo().nativeLibraryDir, "libcloudflared.so");
    }

    public File logFile() {
        return new File(app.getFilesDir(), "tunnel.log");
    }

    /** True when this build carries cloudflared for this device's CPU. */
    public boolean available() {
        Boolean cached = availableCache;
        if (cached == null) {
            cached = binary().exists();
            availableCache = cached;
        }
        return cached;
    }

    public boolean running() {
        Process child = process.get();
        return child != null && child.isAlive();
    }

    public JSONObject status() {
        JSONObject json = new JSONObject();
        try {
            boolean up = running();
            json.put("available", available());
            json.put("running", up);
            json.put("url", up ? url : "");
            json.put("mode", up ? mode : "");
        } catch (Exception ignored) {
            // JSONObject.put only throws for NaN doubles.
        }
        return json;
    }

    /**
     * A named session: the broker already knows the hostname, so the process
     * only needs to come up. The bridge confirms DNS and reachability.
     */
    public synchronized void startNamed(String token, String publicUrl) throws IOException {
        List<String> args = new ArrayList<>();
        args.add("tunnel");
        args.add("--no-autoupdate");
        args.add("run");
        args.add("--token");
        args.add(token);
        begin(args, null, "named", publicUrl);
        if (stopRequested) throw new StoppedException();
        Log.i(TAG, "Named tunnel started for " + publicUrl);
    }

    /**
     * An anonymous quick tunnel: waits until cloudflared prints the
     * trycloudflare address it was given and returns it.
     */
    public synchronized String startQuick(int port) throws IOException {
        List<String> args = new ArrayList<>();
        args.add("tunnel");
        args.add("--no-autoupdate");
        args.add("--url");
        args.add("http://127.0.0.1:" + port);
        UrlWatcher watcher = begin(args, QUICK_URL, "quick", "");
        String found = watcher.await(URL_WAIT_MS);
        if (stopRequested) throw new StoppedException();
        if (found == null) {
            boolean alive = watcher.child.isAlive();
            Process child;
            synchronized (stateLock) {
                child = process.getAndSet(null);
                url = "";
                mode = "";
            }
            killQuietly(child);
            throw new IOException(
                alive
                    ? "The tunnel never reported its address (see tunnel.log)."
                    : "cloudflared exited during startup (see tunnel.log)."
            );
        }
        url = found;
        Log.i(TAG, "Quick tunnel started at " + found);
        return found;
    }

    /** Ends any earlier tunnel, launches cloudflared and starts copying its output. */
    private UrlWatcher begin(List<String> args, Pattern shape, String newMode, String newUrl) throws IOException {
        stop();
        synchronized (stateLock) {
            stopRequested = false;
        }
        Process child = launch(args);
        UrlWatcher watcher = new UrlWatcher(child, shape);
        synchronized (stateLock) {
            process.set(child);
            mode = newMode;
            url = newUrl;
        }
        if (stopRequested) {
            // stop() slipped in between the launch and the hand-over: honour it.
            Process taken;
            synchronized (stateLock) {
                taken = process.getAndSet(null);
                url = "";
                mode = "";
            }
            killQuietly(taken);
            emit("stopped", "");
            throw new StoppedException();
        }
        watcher.start();
        return watcher;
    }

    private Process launch(List<String> args) throws IOException {
        if (!available()) throw new IOException("This build has no tunnel helper for this device.");
        File tmp = new File(app.getCacheDir(), "tunnel-tmp");
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();
        LogFiles.rotateIfOver(logFile(), LOG_CAP_BYTES);
        List<String> command = new ArrayList<>();
        command.add(binary().getAbsolutePath());
        command.addAll(args);
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(app.getFilesDir());
        builder.redirectErrorStream(true);
        Map<String, String> env = builder.environment();
        env.put("HOME", app.getFilesDir().getAbsolutePath());
        env.put("TMPDIR", tmp.getAbsolutePath());
        env.put("LD_LIBRARY_PATH", app.getApplicationInfo().nativeLibraryDir);
        return builder.start();
    }

    /**
     * Ends the tunnel. Never takes the start monitor: it flips the flag and
     * kills the child, which also wakes a startQuick() still waiting for
     * the address. Waits up to five seconds for the exit, so call it from a
     * background thread.
     */
    public void stop() {
        Process child;
        synchronized (stateLock) {
            stopRequested = true;
            child = process.getAndSet(null);
            url = "";
            mode = "";
        }
        if (child == null) return;
        killQuietly(child);
        emit("stopped", "");
    }

    private static void killQuietly(Process child) {
        if (child == null || !child.isAlive()) return;
        child.destroy();
        try {
            if (!child.waitFor(5, TimeUnit.SECONDS)) child.destroyForcibly();
        } catch (InterruptedException e) {
            child.destroyForcibly();
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Copies cloudflared's output into tunnel.log (rotating it past the cap
     * so a long session cannot fill storage), watches a quick tunnel's
     * output for the assigned address, and notices when the process ends
     * on its own.
     */
    private final class UrlWatcher extends Thread {
        final Process child;
        private final Pattern shape;
        private String found;
        private boolean finished;

        UrlWatcher(Process child, Pattern shape) {
            super("odm-tunnel-log");
            this.child = child;
            this.shape = shape;
            setDaemon(true);
        }

        @Override
        public void run() {
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream()))) {
                copy(reader);
            } catch (IOException e) {
                Log.w(TAG, "Tunnel log ended: " + e.getMessage());
            } finally {
                synchronized (this) {
                    finished = true;
                    notifyAll();
                }
                afterExit();
            }
        }

        private void copy(BufferedReader reader) throws IOException {
            FileWriter log = new FileWriter(logFile(), true);
            long written = logFile().length();
            try {
                String line;
                while ((line = reader.readLine()) != null) {
                    if (written > LOG_CAP_BYTES) {
                        log.close();
                        LogFiles.rotateIfOver(logFile(), LOG_CAP_BYTES);
                        log = new FileWriter(logFile(), true);
                        written = 0;
                    }
                    log.write(line);
                    log.write('\n');
                    log.flush();
                    written += line.length() + 1;
                    if (shape != null && found == null) {
                        Matcher match = shape.matcher(line);
                        if (match.find()) {
                            synchronized (this) {
                                found = match.group();
                                notifyAll();
                            }
                        }
                    }
                }
            } finally {
                log.close();
            }
        }

        /** An exit nobody asked for: clear the address, tell the bridge, and drop the "friends can join" notice. */
        private void afterExit() {
            int code = -1;
            try {
                code = child.waitFor();
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            boolean unexpected;
            synchronized (stateLock) {
                unexpected = process.compareAndSet(child, null) && !stopRequested;
                if (unexpected) {
                    url = "";
                    mode = "";
                }
            }
            if (!unexpected) return;
            String message = "The tunnel closed on its own (cloudflared exit " + code + ", see tunnel.log).";
            Log.w(TAG, message);
            emit("error", message);
            WorldService.stop(app);
        }

        synchronized String await(long timeoutMs) {
            long deadline = System.currentTimeMillis() + timeoutMs;
            while (found == null && !finished) {
                long left = deadline - System.currentTimeMillis();
                if (left <= 0) break;
                try {
                    wait(left);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
            }
            return found;
        }
    }
}
