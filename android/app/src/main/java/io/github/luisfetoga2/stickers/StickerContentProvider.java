package io.github.luisfetoga2.stickers;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.content.res.AssetFileDescriptor;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;

import java.io.File;
import java.io.FileNotFoundException;
import java.util.Collections;
import java.util.List;

/**
 * Serves sticker packs to WhatsApp, following the contract of
 * https://github.com/WhatsApp/stickers (Android sample app).
 *
 * content://AUTHORITY/metadata                       all packs
 * content://AUTHORITY/metadata/PACK_ID               one pack
 * content://AUTHORITY/stickers/PACK_ID               stickers of one pack
 * content://AUTHORITY/stickers_asset/PACK_ID/FILE    one image file
 */
public class StickerContentProvider extends ContentProvider {

    private static final String METADATA = "metadata";
    private static final String STICKERS = "stickers";
    private static final String STICKERS_ASSET = "stickers_asset";

    private static final String[] PACK_COLUMNS = {
            "sticker_pack_identifier",
            "sticker_pack_name",
            "sticker_pack_publisher",
            "sticker_pack_icon",
            "android_play_store_link",
            "ios_app_download_link",
            "sticker_pack_publisher_email",
            "sticker_pack_publisher_website",
            "sticker_pack_privacy_policy_website",
            "sticker_pack_license_agreement_website",
            "image_data_version",
            "whatsapp_will_not_cache_stickers",
            "animated_sticker_pack",
    };

    private static final String[] STICKER_COLUMNS = {
            "sticker_file_name",
            "sticker_emoji",
            "sticker_accessibility_text",
    };

    @Override
    public boolean onCreate() {
        return true;
    }

    @Override
    public Cursor query(Uri uri, String[] projection, String selection, String[] selectionArgs, String sortOrder) {
        List<String> segments = uri.getPathSegments();
        if (segments.size() == 1 && METADATA.equals(segments.get(0))) {
            return packCursor(StickerStore.packIds());
        }
        if (segments.size() == 2 && METADATA.equals(segments.get(0))) {
            String packId = segments.get(1);
            return packCursor(StickerStore.isKnownPack(packId)
                    ? Collections.singletonList(packId)
                    : Collections.emptyList());
        }
        if (segments.size() == 2 && STICKERS.equals(segments.get(0))) {
            return stickerCursor(segments.get(1));
        }
        throw new IllegalArgumentException("Unknown URI: " + uri);
    }

    @Override
    public AssetFileDescriptor openAssetFile(Uri uri, String mode) throws FileNotFoundException {
        List<String> segments = uri.getPathSegments();
        if (segments.size() != 3 || !STICKERS_ASSET.equals(segments.get(0))) {
            throw new FileNotFoundException("Unknown URI: " + uri);
        }
        String packId = segments.get(1);
        String fileName = segments.get(2);
        if (!StickerStore.isKnownPack(packId) || fileName.contains("/") || fileName.startsWith(".")) {
            throw new FileNotFoundException("Unknown file: " + uri);
        }
        File file = new File(StickerStore.packDir(requireContext(), packId), fileName);
        if (!file.isFile()) {
            throw new FileNotFoundException("Missing file: " + uri);
        }
        ParcelFileDescriptor fd = ParcelFileDescriptor.open(file, ParcelFileDescriptor.MODE_READ_ONLY);
        return new AssetFileDescriptor(fd, 0, AssetFileDescriptor.UNKNOWN_LENGTH);
    }

    @Override
    public String getType(Uri uri) {
        String authority = BuildConfig.CONTENT_PROVIDER_AUTHORITY;
        List<String> segments = uri.getPathSegments();
        if (segments.isEmpty()) {
            return null;
        }
        switch (segments.get(0)) {
            case METADATA:
                return segments.size() == 1
                        ? "vnd.android.cursor.dir/vnd." + authority + "." + METADATA
                        : "vnd.android.cursor.item/vnd." + authority + "." + METADATA;
            case STICKERS:
                return "vnd.android.cursor.dir/vnd." + authority + "." + STICKERS;
            case STICKERS_ASSET:
                return uri.getLastPathSegment().endsWith(".png") ? "image/png" : "image/webp";
            default:
                return null;
        }
    }

    private Cursor packCursor(List<String> packIds) {
        Context context = requireContext();
        MatrixCursor cursor = new MatrixCursor(PACK_COLUMNS);
        for (String packId : packIds) {
            cursor.addRow(new Object[]{
                    packId,
                    StickerStore.packName(packId),
                    "Sticker Bridge",
                    StickerStore.TRAY_FILE,
                    "",
                    "",
                    "",
                    "https://luisfetoga2.github.io/stickers/",
                    "",
                    "",
                    StickerStore.imageDataVersion(context, packId),
                    0,
                    StickerStore.isAnimated(packId) ? 1 : 0,
            });
        }
        return cursor;
    }

    private Cursor stickerCursor(String packId) {
        MatrixCursor cursor = new MatrixCursor(STICKER_COLUMNS);
        if (!StickerStore.isKnownPack(packId)) {
            return cursor;
        }
        int n = 1;
        for (String file : StickerStore.stickerFiles(requireContext(), packId)) {
            cursor.addRow(new Object[]{file, "⭐", "Test sticker " + n++});
        }
        return cursor;
    }

    @Override
    public Uri insert(Uri uri, ContentValues values) {
        throw new UnsupportedOperationException("Read only");
    }

    @Override
    public int delete(Uri uri, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read only");
    }

    @Override
    public int update(Uri uri, ContentValues values, String selection, String[] selectionArgs) {
        throw new UnsupportedOperationException("Read only");
    }
}
