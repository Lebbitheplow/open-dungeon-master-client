package com.opendungeonmaster.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.SecureRandom;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.TimeUnit;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;
import org.json.JSONObject;

/**
 * Runs the bundled Open Dungeon Master server on this phone. The APK ships a
 * Node runtime as a native library (libnode.so, executable from the app's
 * native library directory) and the server as a zip in assets; the first
 * start unpacks the server into app storage and every start launches
 * <code>node server.js</code> as a child process listening on all
 * interfaces, so friends on the same Wi-Fi can join. Mirrors the desktop
 * shell's LocalServer (src/main/local-server.ts) in shape and behavior.
 */
public final class WorldRuntime {

    private static final String TAG = "ODMWorld";
    private static final int DEFAULT_PORT = 3210;
    private static final long HEALTH_TIMEOUT_MS = 90_000;
    private static final String PAYLOAD_ASSET = "server-payload.zip";
    private static final String PAYLOAD_INFO_ASSET = "server-payload.json";
    private static final String PREFS = "odm-world";

    /** Player-made data inside the server tree that must survive a payload upgrade. */
    private static final String[] PRESERVED = {
        "public/uploads",
        "public/generated",
        "public/generated-audio",
        "public/ambience",
        "models",
    };

    private static WorldRuntime instance;

    public static synchronized WorldRuntime get(Context context) {
        if (instance == null) {
            instance = new WorldRuntime(context.getApplicationContext());
        }
        return instance;
    }

    private final Context app;
    private Process process;
    private int port;
    private volatile String state = "stopped";
    private volatile String error = "";

    private WorldRuntime(Context app) {
        this.app = app;
    }

    // ---------- paths ----------

    private File serverDir() {
        return new File(app.getFilesDir(), "server");
    }

    private File dataDir() {
        return new File(app.getFilesDir(), "data");
    }

    private File dbFile() {
        return new File(dataDir(), "odm.sqlite");
    }

    public File logFile() {
        return new File(app.getFilesDir(), "local-server.log");
    }

    private File nodeBinary() {
        return new File(app.getApplicationInfo().nativeLibraryDir, "libnode.so");
    }

    // ---------- payload ----------

    private JSONObject readInfo(File dir) {
        try {
            byte[] bytes = Files.readAllBytes(new File(dir, "odm-payload.json").toPath());
            return new JSONObject(new String(bytes, StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private JSONObject bundledInfo() {
        try (InputStream in = app.getAssets().open(PAYLOAD_INFO_ASSET)) {
            return new JSONObject(new String(readAll(in), StandardCharsets.UTF_8));
        } catch (Exception e) {
            return null;
        }
    }

    private static byte[] readAll(InputStream in) throws IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        return out.toByteArray();
    }

    /** True when this build carries both a runtime and a server payload. */
    public boolean available() {
        return nodeBinary().exists() && bundledInfo() != null;
    }

    private static void deleteTree(File file) {
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) deleteTree(child);
        }
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private static void copyTree(File from, File to) throws IOException {
        if (from.isDirectory()) {
            if (!to.isDirectory() && !to.mkdirs()) throw new IOException("mkdir " + to);
            File[] children = from.listFiles();
            if (children != null) for (File child : children) copyTree(child, new File(to, child.getName()));
        } else {
            File parent = to.getParentFile();
            if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
            Files.copy(from.toPath(), to.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
        }
    }

    /** Unpacks the bundled server when it is newer than the one on disk, keeping player data. */
    private synchronized void ensurePayload() throws IOException {
        JSONObject fresh = bundledInfo();
        if (fresh == null) throw new IOException("This build has no bundled server payload.");
        JSONObject current = readInfo(serverDir());
        String builtAt = fresh.optString("builtAt", "");
        if (current != null && builtAt.equals(current.optString("builtAt", ""))) return;

        File keep = new File(app.getFilesDir(), "server.keep");
        deleteTree(keep);
        if (current != null) {
            for (String rel : PRESERVED) {
                File from = new File(serverDir(), rel);
                if (from.exists()) copyTree(from, new File(keep, rel));
            }
        }
        deleteTree(serverDir());
        File target = serverDir();
        if (!target.mkdirs()) throw new IOException("Could not create " + target);
        String root = target.getCanonicalPath() + File.separator;
        try (ZipInputStream zip = new ZipInputStream(new BufferedInputStream(app.getAssets().open(PAYLOAD_ASSET)))) {
            ZipEntry entry;
            byte[] buf = new byte[65536];
            while ((entry = zip.getNextEntry()) != null) {
                File out = new File(target, entry.getName());
                if (!out.getCanonicalPath().startsWith(root)) throw new IOException("Bad zip entry " + entry.getName());
                if (entry.isDirectory()) {
                    if (!out.isDirectory() && !out.mkdirs()) throw new IOException("mkdir " + out);
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.isDirectory() && !parent.mkdirs()) throw new IOException("mkdir " + parent);
                try (OutputStream file = new FileOutputStream(out)) {
                    int n;
                    while ((n = zip.read(buf)) > 0) file.write(buf, 0, n);
                }
                zip.closeEntry();
            }
        }
        if (keep.exists()) {
            copyTree(keep, target);
            deleteTree(keep);
        }
        Log.i(TAG, "Unpacked server payload " + builtAt);
    }

    // ---------- process ----------

    private SharedPreferences prefs() {
        return app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static boolean portFree(int candidate) {
        try (ServerSocket probe = new ServerSocket(candidate)) {
            probe.setReuseAddress(true);
            return true;
        } catch (IOException e) {
            return false;
        }
    }

    private int pickPort() throws IOException {
        int wanted = prefs().getInt("port", DEFAULT_PORT);
        if (!portFree(wanted)) {
            if (portFree(DEFAULT_PORT)) {
                wanted = DEFAULT_PORT;
            } else {
                try (ServerSocket any = new ServerSocket(0)) {
                    wanted = any.getLocalPort();
                }
            }
        }
        prefs().edit().putInt("port", wanted).apply();
        return wanted;
    }

    /**
     * The server refuses to run without an encryption key even though the
     * built-in SQLite engine on the phone cannot encrypt; one is minted per
     * install so the same key works if a native engine ever ships.
     */
    private String dbEncryptionKey() throws IOException {
        File keyFile = new File(dataDir(), "db-key");
        if (keyFile.exists()) {
            String existing = new String(Files.readAllBytes(keyFile.toPath()), StandardCharsets.UTF_8).trim();
            if (!existing.isEmpty()) return existing;
        }
        byte[] bytes = new byte[32];
        new SecureRandom().nextBytes(bytes);
        StringBuilder hex = new StringBuilder();
        for (byte b : bytes) hex.append(String.format("%02x", b));
        Files.write(keyFile.toPath(), hex.toString().getBytes(StandardCharsets.UTF_8));
        return hex.toString();
    }

    public String origin() {
        return port > 0 ? "http://127.0.0.1:" + port : "";
    }

    /** The address friends on the same network use; empty when there is no Wi-Fi address. */
    public String lanOrigin() {
        if (port <= 0) return "";
        try {
            for (NetworkInterface iface : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!iface.isUp() || iface.isLoopback()) continue;
                List<InetAddress> addresses = Collections.list(iface.getInetAddresses());
                for (InetAddress address : addresses) {
                    if (address instanceof Inet4Address && !address.isLoopbackAddress() && !address.isLinkLocalAddress()) {
                        return "http://" + address.getHostAddress() + ":" + port;
                    }
                }
            }
        } catch (Exception e) {
            Log.w(TAG, "No LAN address: " + e.getMessage());
        }
        return "";
    }

    public JSONObject status() {
        JSONObject info = bundledInfo();
        JSONObject json = new JSONObject();
        try {
            boolean ok = available();
            json.put("available", ok);
            json.put("state", ok ? state : "unavailable");
            json.put("origin", "running".equals(state) ? origin() : "");
            json.put("lanOrigin", "running".equals(state) ? lanOrigin() : "");
            json.put("firstRun", !dbFile().exists());
            json.put("serverVersion", info != null ? info.optString("serverVersion", "") : "");
            json.put("error", error);
        } catch (Exception ignored) {
            // JSONObject.put only throws for NaN doubles.
        }
        return json;
    }

    private boolean healthy() {
        try {
            HttpURLConnection conn = (HttpURLConnection) new URL(origin() + "/api/health").openConnection();
            conn.setConnectTimeout(2000);
            conn.setReadTimeout(2000);
            int code = conn.getResponseCode();
            conn.disconnect();
            return code >= 200 && code < 300;
        } catch (IOException e) {
            return false;
        }
    }

    public synchronized void start() throws IOException {
        if ("running".equals(state) && process != null && process.isAlive()) return;
        state = "starting";
        error = "";
        try {
            if (!nodeBinary().exists()) throw new IOException("This build has no Node runtime for this device.");
            ensurePayload();
            if (!dataDir().isDirectory() && !dataDir().mkdirs()) throw new IOException("Could not create data dir.");
            File tmp = new File(app.getCacheDir(), "node-tmp");
            //noinspection ResultOfMethodCallIgnored
            tmp.mkdirs();
            port = pickPort();

            ProcessBuilder builder = new ProcessBuilder(nodeBinary().getAbsolutePath(), "server.js");
            builder.directory(serverDir());
            builder.redirectErrorStream(true);
            builder.redirectOutput(ProcessBuilder.Redirect.appendTo(logFile()));
            Map<String, String> env = builder.environment();
            env.put("NODE_ENV", "production");
            env.put("PORT", String.valueOf(port));
            env.put("HOSTNAME", "0.0.0.0");
            env.put("SQLITE_DB_PATH", dbFile().getAbsolutePath());
            env.put("DB_ENCRYPTION_KEY", dbEncryptionKey());
            env.put("ODM_SQLITE_DRIVER", "node");
            env.put("HOME", app.getFilesDir().getAbsolutePath());
            env.put("TMPDIR", tmp.getAbsolutePath());
            env.put("LD_LIBRARY_PATH", app.getApplicationInfo().nativeLibraryDir);
            Process child = builder.start();
            process = child;
            Thread watcher = new Thread(() -> {
                try {
                    int code = child.waitFor();
                    synchronized (WorldRuntime.this) {
                        if (process == child && !"stopping".equals(state) && !"stopped".equals(state)) {
                            state = "error";
                            error = "The world's server stopped unexpectedly (exit " + code + ", see local-server.log).";
                            process = null;
                        }
                    }
                } catch (InterruptedException ignored) {
                    Thread.currentThread().interrupt();
                }
            }, "odm-world-watcher");
            watcher.setDaemon(true);
            watcher.start();

            long deadline = System.currentTimeMillis() + HEALTH_TIMEOUT_MS;
            while (System.currentTimeMillis() < deadline) {
                if (!child.isAlive()) throw new IOException("The world's server exited during startup (see local-server.log).");
                if (healthy()) {
                    state = "running";
                    Log.i(TAG, "World running on port " + port);
                    return;
                }
                try {
                    Thread.sleep(500);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IOException("Interrupted while starting.");
                }
            }
            throw new IOException("The world's server did not become ready in time.");
        } catch (IOException e) {
            stopQuietly();
            state = "error";
            error = e.getMessage() != null ? e.getMessage() : "Could not start the world.";
            throw e;
        }
    }

    private void stopQuietly() {
        Process child = process;
        process = null;
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

    public synchronized void stop() {
        state = "stopping";
        stopQuietly();
        port = 0;
        state = "stopped";
        error = "";
    }

    public String tailLog(int maxBytes) {
        File log = logFile();
        if (!log.exists()) return "";
        try {
            byte[] bytes = Files.readAllBytes(log.toPath());
            int from = Math.max(0, bytes.length - maxBytes);
            return new String(bytes, from, bytes.length - from, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }

    /** Extra environment for diagnostics screens. */
    public Map<String, String> describe() {
        Map<String, String> map = new HashMap<>();
        map.put("node", nodeBinary().getAbsolutePath());
        map.put("server", serverDir().getAbsolutePath());
        map.put("state", state);
        return map;
    }
}
