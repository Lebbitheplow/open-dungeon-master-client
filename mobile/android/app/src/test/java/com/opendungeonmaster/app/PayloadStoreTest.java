package com.opendungeonmaster.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import org.junit.Before;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The upgrade state machine on a temp directory: every interrupted shape must keep the player's uploads. */
public class PayloadStoreTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private File files;
    private PayloadStore store;

    @Before
    public void setUp() throws IOException {
        files = tmp.newFolder("files");
        store = new PayloadStore(files);
    }

    private static void write(File file, String text) throws IOException {
        //noinspection ResultOfMethodCallIgnored
        file.getParentFile().mkdirs();
        Files.write(file.toPath(), text.getBytes(StandardCharsets.UTF_8));
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    private File under(String dir, String rel) {
        return new File(new File(files, dir), rel);
    }

    /** A fake payload: server.js, a built-in picture, and the marker last. */
    private static PayloadStore.Unpacker payload(String version) {
        return dir -> {
            write(new File(dir, "server.js"), "// " + version);
            write(new File(dir, "public/assets/tiles/floor.webp"), "tile " + version);
            PayloadStore.writeMarker(dir, ("{\"builtAt\":\"" + version + "\"}").getBytes(StandardCharsets.UTF_8));
        };
    }

    private void assertClean() {
        assertFalse("server.new left behind", new File(files, "server.new").exists());
        assertFalse("server.old left behind", new File(files, "server.old").exists());
        assertFalse("server.keep left behind", new File(files, "server.keep").exists());
        assertTrue("server/ has its marker", PayloadStore.hasMarker(store.serverDir()));
    }

    @Test
    public void firstInstallUnpacksIntoServer() throws IOException {
        store.upgrade(payload("v1"));
        assertEquals("// v1", read(under("server", "server.js")));
        assertClean();
    }

    @Test
    public void upgradeKeepsPlayerFoldersAndReplacesCode() throws IOException {
        store.upgrade(payload("v1"));
        write(under("server", "public/uploads/a.png"), "mine");
        write(under("server", "models/voice.bin"), "model");
        write(under("server", "public/generated/x.png"), "gen");
        store.upgrade(payload("v2"));
        assertEquals("// v2", read(under("server", "server.js")));
        assertEquals("tile v2", read(under("server", "public/assets/tiles/floor.webp")));
        assertEquals("mine", read(under("server", "public/uploads/a.png")));
        assertEquals("model", read(under("server", "models/voice.bin")));
        assertEquals("gen", read(under("server", "public/generated/x.png")));
        assertClean();
    }

    @Test
    public void failedUnpackLeavesTheLiveTreeUntouched() throws IOException {
        store.upgrade(payload("v1"));
        write(under("server", "public/uploads/a.png"), "mine");
        try {
            store.upgrade(dir -> {
                write(new File(dir, "server.js"), "// partial");
                throw new IOException("disk full");
            });
            fail("expected the unpack failure to propagate");
        } catch (IOException expected) {
            assertEquals("disk full", expected.getMessage());
        }
        assertEquals("// v1", read(under("server", "server.js")));
        assertEquals("mine", read(under("server", "public/uploads/a.png")));
        assertClean();
    }

    @Test
    public void recoverFinishesAnUnpackThatDiedBeforeTheMoves() throws IOException {
        store.upgrade(payload("v1"));
        write(under("server", "public/uploads/a.png"), "mine");
        payload("v2").unpackInto(new File(files, "server.new"));
        store.recover();
        assertEquals("// v2", read(under("server", "server.js")));
        assertEquals("mine", read(under("server", "public/uploads/a.png")));
        assertClean();
    }

    @Test
    public void recoverDiscardsAnUnpackThatDiedBeforeTheMarker() throws IOException {
        store.upgrade(payload("v1"));
        write(under("server", "public/uploads/a.png"), "mine");
        write(under("server.new", "server.js"), "// partial");
        write(under("server.new", "public/uploads/a.png"), "sample from the zip");
        write(under("server.new", "public/uploads/b.png"), "another sample");
        store.recover();
        assertEquals("// v1", read(under("server", "server.js")));
        assertEquals("the player's copy wins", "mine", read(under("server", "public/uploads/a.png")));
        assertTrue("a file server/ lacked is kept rather than deleted", under("server", "public/uploads/b.png").isFile());
        assertClean();
    }

    @Test
    public void recoverCompletesASwapThatDiedBetweenTheRenames() throws IOException {
        store.upgrade(payload("v1"));
        write(under("server", "public/uploads/a.png"), "mine");
        // Interrupted after server -> server.old and before server.new -> server.
        assertTrue(new File(files, "server").renameTo(new File(files, "server.old")));
        payload("v2").unpackInto(new File(files, "server.new"));
        store.recover();
        assertEquals("// v2", read(under("server", "server.js")));
        assertEquals("mine", read(under("server", "public/uploads/a.png")));
        assertClean();
    }

    @Test
    public void recoverMergesALeftoverServerOld() throws IOException {
        store.upgrade(payload("v2"));
        write(under("server.old", "server.js"), "// v1");
        write(under("server.old", "public/uploads/a.png"), "mine");
        store.recover();
        assertEquals("// v2", read(under("server", "server.js")));
        assertEquals("mine", read(under("server", "public/uploads/a.png")));
        assertClean();
    }

    @Test
    public void recoverMergesTheLegacyServerKeepFolder() throws IOException {
        // The old copy-based upgrade died right after deleting server/.
        write(under("server.keep", "public/uploads/a.png"), "mine");
        write(under("server.keep", "public/generated-audio/n.mp3"), "audio");
        store.recover();
        assertTrue(under("server", "public/uploads/a.png").isFile());
        assertFalse(new File(files, "server.keep").exists());
        // The next upgrade then carries those folders into the new tree.
        store.upgrade(payload("v2"));
        assertEquals("mine", read(under("server", "public/uploads/a.png")));
        assertEquals("audio", read(under("server", "public/generated-audio/n.mp3")));
        assertClean();
    }

    @Test
    public void recoverIsANoOpOnAHealthyTree() throws IOException {
        store.upgrade(payload("v1"));
        write(under("server", "public/uploads/a.png"), "mine");
        store.recover();
        assertEquals("// v1", read(under("server", "server.js")));
        assertEquals("mine", read(under("server", "public/uploads/a.png")));
        assertClean();
    }
}
