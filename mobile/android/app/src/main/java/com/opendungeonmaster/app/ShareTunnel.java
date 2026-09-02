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
 */
public final class ShareTunnel {

    private static final String TAG = "ODMShare";
    private static final long URL_WAIT_MS = 45_000;
    private static final long LOG_CAP_BYTES = 2L * 1024 * 1024;
    private static final Pattern QUICK_URL = Pattern.compile("https://[a-z0-9-]+\\.trycloudflare\\.com");

    private static ShareTunnel instance;

    public static synchronized ShareTunnel get(Context context) {
        if (instance == null) {
            instance = new ShareTunnel(context.getApplicationContext());
        }
        return instance;
    }

    private final Context app;
    private Process process;
    private volatile String url = "";
    private volatile String mode = "";

    private ShareTunnel(Context app) {
        this.app = app;
    }

    private File binary() {
        return new File(app.getApplicationInfo().nativeLibraryDir, "libcloudflared.so");
    }

    public File logFile() {
        return new File(app.getFilesDir(), "tunnel.log");
    }

    /** True when this build carries cloudflared for this device's CPU. */
    public boolean available() {
        return binary().exists();
    }

    public boolean running() {
        Process child = process;
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
        stop();
        List<String> args = new ArrayList<>();
        args.add("tunnel");
        args.add("--no-autoupdate");
        args.add("run");
        args.add("--token");
        args.add(token);
        Process child = launch(args);
        UrlWatcher watcher = new UrlWatcher(child, null);
        watcher.start();
        process = child;
        url = publicUrl;
        mode = "named";
        Log.i(TAG, "Named tunnel started for " + publicUrl);
    }

    /**
     * An anonymous quick tunnel: waits until cloudflared prints the
     * trycloudflare address it was given and returns it.
     */
    public synchronized String startQuick(int port) throws IOException {
        stop();
        List<String> args = new ArrayList<>();
        args.add("tunnel");
        args.add("--no-autoupdate");
        args.add("--url");
        args.add("http://127.0.0.1:" + port);
        Process child = launch(args);
        UrlWatcher watcher = new UrlWatcher(child, QUICK_URL);
        watcher.start();
        process = child;
        mode = "quick";
        String found = watcher.await(URL_WAIT_MS);
        if (found == null) {
            stop();
            throw new IOException(
                child.isAlive()
                    ? "The tunnel never reported its address (see tunnel.log)."
                    : "cloudflared exited during startup (see tunnel.log)."
            );
        }
        url = found;
        Log.i(TAG, "Quick tunnel started at " + found);
        return found;
    }

    private Process launch(List<String> args) throws IOException {
        if (!available()) throw new IOException("This build has no tunnel helper for this device.");
        File tmp = new File(app.getCacheDir(), "tunnel-tmp");
        //noinspection ResultOfMethodCallIgnored
        tmp.mkdirs();
        File log = logFile();
        if (log.length() > LOG_CAP_BYTES) {
            //noinspection ResultOfMethodCallIgnored
            log.delete();
        }
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

    public synchronized void stop() {
        Process child = process;
        process = null;
        url = "";
        mode = "";
        if (child != null && child.isAlive()) {
            child.destroy();
            try {
                if (!child.waitFor(5, TimeUnit.SECONDS)) child.destroyForcibly();
            } catch (InterruptedException e) {
                child.destroyForcibly();
                Thread.currentThread().interrupt();
            }
        }
    }

    /**
     * Copies cloudflared's output into tunnel.log and, for a quick tunnel,
     * watches it for the assigned address.
     */
    private final class UrlWatcher extends Thread {
        private final Process child;
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
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(child.getInputStream()));
                 FileWriter log = new FileWriter(logFile(), true)) {
                String line;
                while ((line = reader.readLine()) != null) {
                    log.write(line);
                    log.write('\n');
                    log.flush();
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
            } catch (IOException e) {
                Log.w(TAG, "Tunnel log ended: " + e.getMessage());
            } finally {
                synchronized (this) {
                    finished = true;
                    notifyAll();
                }
            }
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
