package com.opendungeonmaster.app;

import java.io.File;
import java.io.IOException;
import java.io.RandomAccessFile;
import java.nio.charset.StandardCharsets;

/**
 * Log housekeeping shared by the world's server log and the tunnel log:
 * both used to grow without bound and were read back whole.
 */
final class LogFiles {

    private LogFiles() {}

    /**
     * When the log is over the cap, moves it aside as <name>.1 (replacing
     * the previous .1) so the next write starts a fresh file. One previous
     * log is kept for diagnostics. Returns true when it rotated.
     */
    static boolean rotateIfOver(File log, long capBytes) {
        if (!log.isFile() || log.length() <= capBytes) return false;
        File previous = new File(log.getParentFile(), log.getName() + ".1");
        //noinspection ResultOfMethodCallIgnored
        previous.delete();
        if (log.renameTo(previous)) return true;
        // A rename can fail on an odd filesystem; losing the log beats growing it forever.
        //noinspection ResultOfMethodCallIgnored
        log.delete();
        return true;
    }

    /** The last maxBytes of the file as text, read by seeking rather than loading the whole file. */
    static String tail(File log, int maxBytes) {
        if (!log.isFile()) return "";
        return readAfter(log, log.length() - maxBytes, maxBytes);
    }

    /** Up to maxBytes of text starting at a byte offset (clamped to the file). */
    static String readAfter(File log, long offset, int maxBytes) {
        if (!log.isFile()) return "";
        try (RandomAccessFile raf = new RandomAccessFile(log, "r")) {
            long length = raf.length();
            long from = Math.max(0, Math.min(offset, length));
            int size = (int) Math.min(length - from, maxBytes);
            if (size <= 0) return "";
            byte[] bytes = new byte[size];
            raf.seek(from);
            raf.readFully(bytes);
            return new String(bytes, StandardCharsets.UTF_8);
        } catch (IOException e) {
            return "";
        }
    }
}
