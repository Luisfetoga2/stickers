package io.github.luisfetoga2.stickers;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.ImageDecoder;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * Keeps sticker packs as files under filesDir/packs/.
 * packs/index.json lists the packs. Each packs/<packId>/ folder holds tray.png and the .webp stickers.
 * WhatsApp reads through the content provider while the editor writes, so every method is synchronized.
 */
final class StickerStore {

    static final String TRAY_FILE = "tray.png";
    static final int STATIC_LIMIT = 100 * 1024;
    static final int ANIMATED_LIMIT = 500 * 1024;

    private static final int STICKER_SIZE = 512;
    private static final int TRAY_SIZE = 96;

    static final class Pack {
        final String id;
        final String name;
        final boolean animated;
        final int number;
        int version;
        final List<String> stickers;
        /** True when the pack changed and WhatsApp has not confirmed the new version yet. */
        boolean needsUpdate;

        Pack(String id, String name, boolean animated, int number, int version, List<String> stickers,
             boolean needsUpdate) {
            this.id = id;
            this.name = name;
            this.animated = animated;
            this.number = number;
            this.version = version;
            this.stickers = stickers;
            this.needsUpdate = needsUpdate;
        }
    }

    private static List<Pack> cache;

    private StickerStore() {
    }

    /** Packs that WhatsApp can show: the ones with at least one sticker. */
    static synchronized List<Pack> visiblePacks(Context context) {
        List<Pack> visible = new ArrayList<>();
        for (Pack pack : load(context)) {
            if (!pack.stickers.isEmpty()) {
                visible.add(pack);
            }
        }
        return visible;
    }

    /** Copies of every pack, including empty ones, in the order they were made. Safe to read on any thread. */
    static synchronized List<Pack> allPacks(Context context) {
        List<Pack> copies = new ArrayList<>();
        for (Pack p : load(context)) {
            copies.add(new Pack(p.id, p.name, p.animated, p.number, p.version, new ArrayList<>(p.stickers),
                    p.needsUpdate));
        }
        return copies;
    }

    static synchronized Pack find(Context context, String packId) {
        for (Pack pack : load(context)) {
            if (pack.id.equals(packId)) {
                return pack;
            }
        }
        return null;
    }

    static synchronized List<String> stickers(Context context, String packId) {
        Pack pack = find(context, packId);
        return pack == null ? Collections.emptyList() : new ArrayList<>(pack.stickers);
    }

    static File packDir(Context context, String packId) {
        return new File(root(context), packId);
    }

    /** Saves a new sticker in the open pack of its kind, or starts a new pack when that one is full. */
    static synchronized Pack addSticker(Context context, byte[] webp, boolean animated) throws IOException {
        Bitmap firstFrame = validate(webp, animated);
        List<Pack> packs = load(context);

        Pack target = null;
        int lastNumber = 0;
        for (Pack pack : packs) {
            if (pack.animated != animated) {
                continue;
            }
            lastNumber = Math.max(lastNumber, pack.number);
            if (!PackPlanner.isFull(pack.stickers.size())) {
                target = pack;
            }
        }
        if (target == null) {
            int number = lastNumber + 1;
            target = new Pack(PackPlanner.packId(animated, number), PackPlanner.packName(animated, number),
                    animated, number, 1, new ArrayList<>(), true);
            packs.add(target);
        }

        File dir = packDir(context, target.id);
        if (!dir.isDirectory() && !dir.mkdirs()) {
            throw new IOException("Could not create " + dir);
        }
        String name = "s" + System.currentTimeMillis() + ".webp";
        while (new File(dir, name).exists()) {
            name = "s" + System.currentTimeMillis() + "_" + (int) (Math.random() * 1000) + ".webp";
        }
        writeAtomically(new File(dir, name), webp);

        target.stickers.add(name);
        target.version++;
        target.needsUpdate = true;
        if (target.stickers.size() == 1) {
            writeTray(firstFrame, new File(dir, TRAY_FILE));
        }
        save(context, packs);
        return target;
    }

    /** Removes one sticker. WhatsApp keeps showing it until the pack is sent to WhatsApp again. */
    static synchronized Pack deleteSticker(Context context, String packId, String file) throws IOException {
        Pack pack = find(context, packId);
        if (pack == null || !pack.stickers.contains(file)) {
            throw new IOException("This sticker is already gone.");
        }
        boolean wasFirst = pack.stickers.get(0).equals(file);
        pack.stickers.remove(file);
        pack.version++;
        pack.needsUpdate = true;

        File dir = packDir(context, packId);
        if (wasFirst && !pack.stickers.isEmpty()) {
            // The tray icon shows the first sticker, so it follows the new first one.
            byte[] first = Files.readAllBytes(new File(dir, pack.stickers.get(0)).toPath());
            writeTray(decodeFirstFrame(first), new File(dir, TRAY_FILE));
        }
        save(context, load(context));
        //noinspection ResultOfMethodCallIgnored
        new File(dir, file).delete();
        return pack;
    }

    /** WhatsApp accepted the current version of the pack. */
    static synchronized void markUpdated(Context context, String packId) throws IOException {
        Pack pack = find(context, packId);
        if (pack != null && pack.needsUpdate) {
            pack.needsUpdate = false;
            save(context, load(context));
        }
    }

    /** Checks size and format, and returns the first frame for the tray icon. */
    private static Bitmap validate(byte[] webp, boolean animated) throws IOException {
        int limit = animated ? ANIMATED_LIMIT : STATIC_LIMIT;
        if (webp.length > limit) {
            throw new IOException("The sticker is " + webp.length / 1024 + " KB. The limit is " + limit / 1024 + " KB.");
        }
        if (webp.length < 12 || webp[0] != 'R' || webp[1] != 'I' || webp[2] != 'F' || webp[3] != 'F'
                || webp[8] != 'W' || webp[9] != 'E' || webp[10] != 'B' || webp[11] != 'P') {
            throw new IOException("The sticker is not a WebP file.");
        }
        Bitmap first = decodeFirstFrame(webp);
        if (first.getWidth() != STICKER_SIZE || first.getHeight() != STICKER_SIZE) {
            throw new IOException("The sticker is " + first.getWidth() + "x" + first.getHeight() + ". It must be 512x512.");
        }
        return first;
    }

    /** ImageDecoder reads both static and animated WebP. For animated files it returns the first frame. */
    private static Bitmap decodeFirstFrame(byte[] webp) throws IOException {
        try {
            return ImageDecoder.decodeBitmap(ImageDecoder.createSource(ByteBuffer.wrap(webp)),
                    (decoder, info, source) -> decoder.setAllocator(ImageDecoder.ALLOCATOR_SOFTWARE));
        } catch (IOException e) {
            throw new IOException("Android could not read the sticker: " + e.getMessage(), e);
        }
    }

    /** The tray icon is the first sticker, scaled to 96x96. For animated stickers this is the first frame. */
    private static void writeTray(Bitmap full, File target) throws IOException {
        Bitmap tray = Bitmap.createScaledBitmap(full, TRAY_SIZE, TRAY_SIZE, true);
        File tmp = new File(target.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            tray.compress(Bitmap.CompressFormat.PNG, 100, out);
        }
        if (!tmp.renameTo(target)) {
            throw new IOException("Could not save the tray icon.");
        }
    }

    private static File root(Context context) {
        return new File(context.getFilesDir(), "packs");
    }

    private static List<Pack> load(Context context) {
        if (cache != null) {
            return cache;
        }
        List<Pack> packs = new ArrayList<>();
        File index = new File(root(context), "index.json");
        if (index.isFile()) {
            try {
                String json = new String(Files.readAllBytes(index.toPath()), StandardCharsets.UTF_8);
                JSONArray array = new JSONObject(json).getJSONArray("packs");
                for (int i = 0; i < array.length(); i++) {
                    JSONObject p = array.getJSONObject(i);
                    JSONArray s = p.getJSONArray("stickers");
                    List<String> stickers = new ArrayList<>();
                    for (int j = 0; j < s.length(); j++) {
                        stickers.add(s.getString(j));
                    }
                    packs.add(new Pack(p.getString("id"), p.getString("name"), p.getBoolean("animated"),
                            p.getInt("number"), p.getInt("version"), stickers, p.optBoolean("needsUpdate", false)));
                }
            } catch (IOException | JSONException e) {
                throw new IllegalStateException("The pack index is damaged: " + e.getMessage(), e);
            }
        }
        cache = packs;
        return packs;
    }

    private static void save(Context context, List<Pack> packs) throws IOException {
        try {
            JSONArray array = new JSONArray();
            for (Pack pack : packs) {
                array.put(new JSONObject()
                        .put("id", pack.id)
                        .put("name", pack.name)
                        .put("animated", pack.animated)
                        .put("number", pack.number)
                        .put("version", pack.version)
                        .put("needsUpdate", pack.needsUpdate)
                        .put("stickers", new JSONArray(pack.stickers)));
            }
            byte[] json = new JSONObject().put("packs", array).toString(2).getBytes(StandardCharsets.UTF_8);
            File dir = root(context);
            if (!dir.isDirectory() && !dir.mkdirs()) {
                throw new IOException("Could not create " + dir);
            }
            writeAtomically(new File(dir, "index.json"), json);
        } catch (JSONException e) {
            throw new IOException(e);
        }
    }

    private static void writeAtomically(File target, byte[] data) throws IOException {
        File tmp = new File(target.getPath() + ".tmp");
        try (FileOutputStream out = new FileOutputStream(tmp)) {
            out.write(data);
            out.getFD().sync();
        }
        if (!tmp.renameTo(target)) {
            throw new IOException("Could not save " + target.getName());
        }
    }
}
