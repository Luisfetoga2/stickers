package io.github.luisfetoga2.stickers;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
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

        Pack(String id, String name, boolean animated, int number, int version, List<String> stickers) {
            this.id = id;
            this.name = name;
            this.animated = animated;
            this.number = number;
            this.version = version;
            this.stickers = stickers;
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
        validate(webp, animated);
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
                    animated, number, 1, new ArrayList<>());
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
        if (target.stickers.size() == 1) {
            writeTray(webp, new File(dir, TRAY_FILE));
        }
        save(context, packs);
        return target;
    }

    private static void validate(byte[] webp, boolean animated) throws IOException {
        int limit = animated ? ANIMATED_LIMIT : STATIC_LIMIT;
        if (webp.length > limit) {
            throw new IOException("The sticker is " + webp.length / 1024 + " KB. The limit is " + limit / 1024 + " KB.");
        }
        if (webp.length < 12 || webp[0] != 'R' || webp[1] != 'I' || webp[2] != 'F' || webp[3] != 'F'
                || webp[8] != 'W' || webp[9] != 'E' || webp[10] != 'B' || webp[11] != 'P') {
            throw new IOException("The sticker is not a WebP file.");
        }
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        BitmapFactory.decodeByteArray(webp, 0, webp.length, bounds);
        if (bounds.outWidth != STICKER_SIZE || bounds.outHeight != STICKER_SIZE) {
            throw new IOException("The sticker is " + bounds.outWidth + "x" + bounds.outHeight + ". It must be 512x512.");
        }
    }

    /** The tray icon is the first sticker, scaled to 96x96. For animated stickers this is the first frame. */
    private static void writeTray(byte[] webp, File target) throws IOException {
        Bitmap full = BitmapFactory.decodeByteArray(webp, 0, webp.length);
        if (full == null) {
            throw new IOException("Could not read the sticker to make the tray icon.");
        }
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
                            p.getInt("number"), p.getInt("version"), stickers));
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
