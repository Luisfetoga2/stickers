package io.github.luisfetoga2.stickers;

import android.content.Context;
import android.content.SharedPreferences;
import android.content.res.AssetManager;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

/**
 * Keeps sticker packs as plain files under filesDir/packs/<packId>/.
 * Each pack folder holds tray.png plus one .webp file per sticker.
 */
final class StickerStore {

    static final String STATIC_PACK = "static_test";
    static final String ANIMATED_PACK = "animated_test";
    static final String TRAY_FILE = "tray.png";

    private static final String PREFS = "sticker_store";

    private StickerStore() {
    }

    static List<String> packIds() {
        return Arrays.asList(STATIC_PACK, ANIMATED_PACK);
    }

    static boolean isKnownPack(String packId) {
        return packIds().contains(packId);
    }

    static String packName(String packId) {
        return ANIMATED_PACK.equals(packId) ? "Test animated" : "Test stickers";
    }

    static boolean isAnimated(String packId) {
        return ANIMATED_PACK.equals(packId);
    }

    static File packDir(Context context, String packId) {
        return new File(new File(context.getFilesDir(), "packs"), packId);
    }

    static List<String> stickerFiles(Context context, String packId) {
        String[] names = packDir(context, packId).list((dir, name) -> name.endsWith(".webp"));
        if (names == null) {
            return Collections.emptyList();
        }
        List<String> files = new ArrayList<>(Arrays.asList(names));
        Collections.sort(files);
        return files;
    }

    /** WhatsApp re-reads a pack when this value changes. */
    static String imageDataVersion(Context context, String packId) {
        return String.valueOf(prefs(context).getInt("version_" + packId, 1));
    }

    static void installSamples(Context context) throws IOException {
        copyAssetFolder(context, "samples/static", packDir(context, STATIC_PACK));
        copyAssetFolder(context, "samples/animated", packDir(context, ANIMATED_PACK));
    }

    /** Adds a 4th sticker to the static pack, to test how WhatsApp picks up changes. */
    static boolean addExtraSticker(Context context) throws IOException {
        File target = new File(packDir(context, STATIC_PACK), "4.webp");
        if (target.exists()) {
            return false;
        }
        try (InputStream in = context.getAssets().open("samples/extra/new.webp")) {
            copy(in, target);
        }
        SharedPreferences prefs = prefs(context);
        String key = "version_" + STATIC_PACK;
        prefs.edit().putInt(key, prefs.getInt(key, 1) + 1).apply();
        return true;
    }

    private static void copyAssetFolder(Context context, String assetDir, File targetDir) throws IOException {
        if (!targetDir.isDirectory() && !targetDir.mkdirs()) {
            throw new IOException("Could not create " + targetDir);
        }
        AssetManager assets = context.getAssets();
        String[] names = assets.list(assetDir);
        if (names == null) {
            return;
        }
        for (String name : names) {
            File target = new File(targetDir, name);
            if (target.exists()) {
                continue;
            }
            try (InputStream in = assets.open(assetDir + "/" + name)) {
                copy(in, target);
            }
        }
    }

    private static void copy(InputStream in, File target) throws IOException {
        try (OutputStream out = new FileOutputStream(target)) {
            byte[] buffer = new byte[16 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
        }
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }
}
