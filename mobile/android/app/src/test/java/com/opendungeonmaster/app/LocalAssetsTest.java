package com.opendungeonmaster.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.HashMap;
import java.util.Map;
import org.junit.Rule;
import org.junit.Test;
import org.junit.rules.TemporaryFolder;

/** The app's own art lands in the server's public tree where the renderer's manifest says it lives. */
public class LocalAssetsTest {

    @Rule
    public TemporaryFolder tmp = new TemporaryFolder();

    private static WorldEnvironment.AssetSource source(Map<String, String> files) {
        return (path) -> {
            String text = files.get(path);
            if (text == null) throw new FileNotFoundException(path);
            return new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8));
        };
    }

    private static String read(File file) throws IOException {
        return new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8);
    }

    @Test
    public void foldersMapTheWayTheRendererLaysThemOut() {
        assertEquals("game/icons/spell/", WorldEnvironment.localFolder("/assets/icons/spell/"));
        assertEquals("game/ui-art/door/", WorldEnvironment.localFolder("/assets/ui/door/"));
        assertEquals("game/public/assets/tiles/floor/", WorldEnvironment.localFolder("/assets/tiles/floor/"));
        assertEquals("game/public/dice-box/textures/", WorldEnvironment.localFolder("/dice-box/textures/"));
    }

    @Test
    public void everyManifestEntryIsWrittenUnderPublic() throws IOException {
        Map<String, String> files = new HashMap<>();
        files.put(WorldEnvironment.LOCAL_ASSET_MANIFEST,
                "{\"/assets/icons/spell/\":[\"fireball.webp\"],"
                        + "\"/assets/ui/door/\":[\"horror.webp\"],"
                        + "\"/assets/tiles/floor/\":[\"grass.webp\",\"stone.webp\"],"
                        + "\"/dice-box/\":[\"dice.json\"]}");
        files.put("game/icons/spell/fireball.webp", "icon");
        files.put("game/ui-art/door/horror.webp", "door");
        files.put("game/public/assets/tiles/floor/grass.webp", "grass");
        files.put("game/public/assets/tiles/floor/stone.webp", "stone");
        files.put("game/public/dice-box/dice.json", "{}");
        File target = tmp.newFolder("server");

        assertEquals(5, WorldEnvironment.copyLocalAssets(source(files), target));

        assertEquals("icon", read(new File(target, "public/assets/icons/spell/fireball.webp")));
        assertEquals("door", read(new File(target, "public/assets/ui/door/horror.webp")));
        assertEquals("grass", read(new File(target, "public/assets/tiles/floor/grass.webp")));
        assertEquals("stone", read(new File(target, "public/assets/tiles/floor/stone.webp")));
        assertEquals("{}", read(new File(target, "public/dice-box/dice.json")));
    }

    @Test
    public void aBuildWithoutAManifestLeavesThePayloadAlone() throws IOException {
        File target = tmp.newFolder("server");
        assertEquals(0, WorldEnvironment.copyLocalAssets(source(new HashMap<>()), target));
        assertFalse(new File(target, "public").exists());
    }

    @Test
    public void aFileTheManifestListsButTheBuildLacksFails() throws IOException {
        Map<String, String> files = new HashMap<>();
        files.put(WorldEnvironment.LOCAL_ASSET_MANIFEST, "{\"/assets/tiles/\":[\"missing.webp\"]}");
        try {
            WorldEnvironment.copyLocalAssets(source(files), tmp.newFolder("server"));
            fail("a manifest entry with no file behind it should not pass quietly");
        } catch (IOException expected) {
            assertTrue(expected.getMessage().contains("missing.webp"));
        }
    }

    @Test
    public void namesThatWouldEscapeTheFolderAreSkipped() throws IOException {
        Map<String, String> files = new HashMap<>();
        files.put(WorldEnvironment.LOCAL_ASSET_MANIFEST, "{\"/assets/tiles/\":[\"../escape.webp\",\"ok.webp\"]}");
        files.put("game/public/assets/tiles/ok.webp", "ok");
        File target = tmp.newFolder("server");
        assertEquals(1, WorldEnvironment.copyLocalAssets(source(files), target));
        assertFalse(new File(target, "public/assets/escape.webp").exists());
        assertTrue(new File(target, "public/assets/tiles/ok.webp").isFile());
    }
}
