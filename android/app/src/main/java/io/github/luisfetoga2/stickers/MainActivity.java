package io.github.luisfetoga2.stickers;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.view.WindowInsets;
import android.view.textclassifier.TextClassifier;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Hosts the editor (assets/editor) in a WebView and connects it to WhatsApp.
 * The editor loads from https://appassets.androidplatform.net so that canvas exports are not blocked.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String EDITOR_URL = "https://" + HOST + "/assets/editor/index.html";
    private static final int REQUEST_ADD_PACK = 200;
    private static final int REQUEST_PICK_FILE = 201;
    private static final int REQUEST_PICK_MEDIA = 202;

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private File sharedDir;
    private File workDir;
    private BackgroundRemover remover;
    private LinkDownloader links;
    /** A link status that arrived before the editor was ready: [method, JSON argument]. */
    private String[] pendingLinkEvent;
    /** The version name of a newer release on GitHub, waiting for the editor. */
    private String pendingUpdate;
    /** A copied link to offer, waiting for the editor. */
    private String pendingClipboardLink;
    /** MIME type of the file in sharedDir. Read on a WebView thread. */
    private volatile String sharedMime = "application/octet-stream";

    /** True after the editor called ready(). */
    private boolean editorReady;
    /** A shared file copied into the cache, waiting for the editor. */
    private JSONObject pendingShare;
    private String pendingPackName;
    private String pendingPackId;
    /** Packs still waiting to be sent to WhatsApp after the user tapped Update WhatsApp. */
    private final ArrayDeque<String> updateQueue = new ArrayDeque<>();
    private boolean updating;
    private String updateNote = "";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getActionBar() != null) {
            getActionBar().hide();
        }
        sharedDir = new File(getCacheDir(), "shared");
        workDir = new File(getCacheDir(), "work");
        remover = new BackgroundRemover(this, io);
        links = new LinkDownloader(this);
        links.warmUp();
        UpdateChecker.check(this, BuildConfig.VERSION_CODE, build -> main.post(() -> {
            pendingUpdate = UpdateChecker.versionName(build);
            deliverShare();
        }));

        boolean dark = (getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
                == Configuration.UI_MODE_NIGHT_YES;
        int background = dark ? Color.parseColor("#111113") : Color.parseColor("#f5f5f7");

        FrameLayout frame = new FrameLayout(this);
        frame.setBackgroundColor(background);
        // Android 15 draws apps edge to edge. Keep the editor clear of the status bar, nav bar, and keyboard.
        frame.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsets.CONSUMED;
        });

        webView = new WebView(this);
        webView.setBackgroundColor(background);
        frame.addView(webView);
        setContentView(frame);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/assets/", new WebViewAssetLoader.AssetsPathHandler(this))
                .addPathHandler("/shared/", this::serveSharedFile)
                .addPathHandler("/work/", this::serveWorkFile)
                .addPathHandler("/stickers/", this::serveStickerFile)
                .build();

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // The editor never leaves the app.
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_PICK_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        webView.addJavascriptInterface(new Bridge(), "StickerBridge");
        webView.loadUrl(EDITOR_URL);
        handleShare(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleShare(intent);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Android lets an app read the clipboard only while it has focus.
        if (hasFocus) {
            checkClipboard();
        }
    }

    /**
     * Offers a link the user copied since the last look. Reading the clipboard shows a system message on
     * Android 12 and newer, so the app reads it only when the clip is new, and skips clips that Android
     * already marked as not a link.
     */
    private void checkClipboard() {
        ClipboardManager clipboard = getSystemService(ClipboardManager.class);
        if (clipboard == null || !clipboard.hasPrimaryClip()) {
            return;
        }
        ClipDescription description = clipboard.getPrimaryClipDescription();
        if (description == null || !description.hasMimeType("text/*")) {
            return;
        }
        SharedPreferences prefs = getSharedPreferences("clipboard", MODE_PRIVATE);
        long stamp = description.getTimestamp();
        if (stamp == prefs.getLong("lastClip", -1)) {
            return;
        }
        prefs.edit().putLong("lastClip", stamp).apply();
        if (Build.VERSION.SDK_INT >= 31
                && description.getClassificationStatus() == ClipDescription.CLASSIFICATION_COMPLETE
                && description.getConfidenceScore(TextClassifier.TYPE_URL) < 0.5f) {
            return;
        }
        ClipData clip = clipboard.getPrimaryClip();
        if (clip == null || clip.getItemCount() == 0) {
            return;
        }
        String url = LinkDownloader.firstUrl(String.valueOf(clip.getItemAt(0).coerceToText(this)));
        if (url != null) {
            pendingClipboardLink = url;
            deliverShare();
        }
    }

    /** The editor uses browser history for its screens, so Back returns to the start screen before it leaves. */
    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        remover.close();
        links.shutdown();
        io.shutdown();
        webView.destroy();
        super.onDestroy();
    }

    /** Opens a file or a link that another app shared with Sticker Bridge. */
    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return;
        }
        // TikTok, Instagram, YouTube, and others share a post as text with a link in it.
        String type = intent.getType();
        if (type != null && type.startsWith("text/")) {
            String url = LinkDownloader.firstUrl(intent.getStringExtra(Intent.EXTRA_TEXT));
            if (url != null) {
                openLink(url);
            } else {
                sendLinkEvent("onLinkError", "The shared text has no link in it.");
            }
            return;
        }
        Uri uri = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : legacyStream(intent);
        if (uri != null) {
            openIncoming(uri, intent.getType());
        }
    }

    /** The Android photo picker shows photos, GIFs, and videos, and always reports the real file type. */
    private void pickMedia() {
        Intent intent;
        if (Build.VERSION.SDK_INT >= 33) {
            intent = new Intent(MediaStore.ACTION_PICK_IMAGES);
        } else {
            intent = new Intent(Intent.ACTION_GET_CONTENT);
            intent.addCategory(Intent.CATEGORY_OPENABLE);
            intent.setType("*/*");
            intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"image/*", "video/*"});
        }
        try {
            startActivityForResult(intent, REQUEST_PICK_MEDIA);
        } catch (ActivityNotFoundException e) {
            sendAddResult(false, "This phone has no photo picker: " + e.getMessage());
        }
    }

    /** Copies a shared or picked file into the cache, then hands its URL to the editor. */
    private void openIncoming(Uri uri, String typeHint) {
        // The content provider knows the exact type. A share intent can carry a vague one, such as image/*.
        String resolved = getContentResolver().getType(uri);
        String mime = resolved != null ? resolved : typeHint;
        if (editorReady) {
            callEditor("onOpening", "{}");
        }
        io.execute(() -> {
            try {
                String name = copyShared(uri);
                sharedMime = mime == null ? "application/octet-stream" : mime;
                JSONObject file = new JSONObject()
                        .put("url", "https://" + HOST + "/shared/" + name)
                        .put("mime", sharedMime);
                main.post(() -> {
                    pendingShare = file;
                    deliverShare();
                });
            } catch (IOException | JSONException e) {
                main.post(() -> sendAddResult(false, "Could not open the shared file: " + e.getMessage()));
            }
        });
    }

    @SuppressWarnings("deprecation")
    private static Uri legacyStream(Intent intent) {
        return intent.getParcelableExtra(Intent.EXTRA_STREAM);
    }

    private String copyShared(Uri uri) throws IOException {
        File[] old = sharedDir.listFiles();
        if (old != null) {
            for (File f : old) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        if (!sharedDir.isDirectory() && !sharedDir.mkdirs()) {
            throw new IOException("Could not create the cache folder.");
        }
        String name = "file" + System.currentTimeMillis();
        try (InputStream in = getContentResolver().openInputStream(uri);
             OutputStream out = new FileOutputStream(new File(sharedDir, name))) {
            if (in == null) {
                throw new IOException("The other app did not give access to the file.");
            }
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
        }
        return name;
    }

    private WebResourceResponse serveSharedFile(String path) {
        if (!path.matches("file[0-9]+")) {
            return null;
        }
        File file = new File(sharedDir, path);
        if (!file.isFile()) {
            return null;
        }
        try {
            return new WebResourceResponse(sharedMime, null, new FileInputStream(file));
        } catch (IOException e) {
            return null;
        }
    }

    /** Serves masks from background removal. */
    private WebResourceResponse serveWorkFile(String path) {
        if (!path.matches("mask[0-9]+\\.png")) {
            return null;
        }
        File file = new File(workDir, path);
        if (!file.isFile()) {
            return null;
        }
        try {
            return new WebResourceResponse("image/png", null, new FileInputStream(file));
        } catch (IOException e) {
            return null;
        }
    }

    private String saveMask(Bitmap mask) throws IOException {
        File[] old = workDir.listFiles();
        if (old != null) {
            for (File f : old) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        if (!workDir.isDirectory() && !workDir.mkdirs()) {
            throw new IOException("Could not create the cache folder.");
        }
        String name = "mask" + System.currentTimeMillis() + ".png";
        try (OutputStream out = new FileOutputStream(new File(workDir, name))) {
            if (!mask.compress(Bitmap.CompressFormat.PNG, 100, out)) {
                throw new IOException("Could not encode the mask.");
            }
        }
        return name;
    }

    private void sendBackgroundResult(String id, boolean ok, String key, String value) {
        try {
            callEditor("onBackgroundResult", new JSONObject().put("id", id).put("ok", ok).put(key, value).toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void sendMaskResult(String id, String url, long modelMs) {
        try {
            callEditor("onBackgroundResult", new JSONObject()
                    .put("id", id)
                    .put("ok", true)
                    .put("url", url)
                    .put("ms", modelMs)
                    .toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void sendBackgroundProgress(String id, String message) {
        try {
            callEditor("onBackgroundProgress", new JSONObject().put("id", id).put("message", message).toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Downloads the video of a post with yt-dlp, then opens it like a shared file. */
    private void openLink(String url) {
        sendLinkEvent("onLinkProgress", "Opening the link…");
        links.download(url, new File(getCacheDir(), "link"), new LinkDownloader.Listener() {
            @Override
            public void onProgress(String message) {
                main.post(() -> sendLinkEvent("onLinkProgress", message));
            }

            @Override
            public void onFile(File file) {
                String mime = LinkDownloader.mimeOf(file);
                io.execute(() -> {
                    try {
                        String name = moveToShared(file);
                        JSONObject shared = new JSONObject()
                                .put("url", "https://" + HOST + "/shared/" + name)
                                .put("mime", mime);
                        main.post(() -> {
                            sharedMime = mime;
                            pendingShare = shared;
                            deliverShare();
                        });
                    } catch (IOException | JSONException e) {
                        main.post(() -> sendLinkEvent("onLinkError", "Could not open the download: " + e.getMessage()));
                    }
                });
            }

            @Override
            public void onError(String message) {
                main.post(() -> sendLinkEvent("onLinkError", message));
            }
        });
    }

    /** Moves a downloaded file to where the editor reads shared files. */
    private String moveToShared(File file) throws IOException {
        File[] old = sharedDir.listFiles();
        if (old != null) {
            for (File f : old) {
                //noinspection ResultOfMethodCallIgnored
                f.delete();
            }
        }
        if (!sharedDir.isDirectory() && !sharedDir.mkdirs()) {
            throw new IOException("Could not create the cache folder.");
        }
        String name = "file" + System.currentTimeMillis();
        if (!file.renameTo(new File(sharedDir, name))) {
            throw new IOException("Could not move the download.");
        }
        return name;
    }

    /** Sends a link status to the editor, or keeps the last one until the editor is ready. */
    private void sendLinkEvent(String method, String message) {
        String json = JSONObject.quote(message);
        if (editorReady) {
            callEditor(method, json);
        } else {
            pendingLinkEvent = new String[]{method, json};
        }
    }

    private void deliverShare() {
        if (editorReady && pendingClipboardLink != null) {
            callEditor("onClipboardLink", JSONObject.quote(pendingClipboardLink));
            pendingClipboardLink = null;
        }
        if (editorReady && pendingUpdate != null) {
            callEditor("onUpdateAvailable", JSONObject.quote(pendingUpdate));
            pendingUpdate = null;
        }
        if (editorReady && pendingLinkEvent != null) {
            callEditor(pendingLinkEvent[0], pendingLinkEvent[1]);
            pendingLinkEvent = null;
        }
        if (!editorReady || pendingShare == null) {
            return;
        }
        callEditor("onSharedFile", pendingShare.toString());
        pendingShare = null;
    }

    private void callEditor(String method, String jsonArgument) {
        webView.evaluateJavascript(
                "window.__stickerBridge && window.__stickerBridge." + method + "(" + jsonArgument + ")", null);
    }

    private void sendAddResult(boolean ok, String message) {
        try {
            callEditor("onAddResult", new JSONObject().put("ok", ok).put("message", message).toString());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    private void openWhatsApp(StickerStore.Pack pack) {
        String target = whatsAppPackage();
        if (target == null) {
            sendAddResult(false, "The sticker is saved, but WhatsApp is not installed.");
            return;
        }
        Intent intent = new Intent("com.whatsapp.intent.action.ENABLE_STICKER_PACK");
        intent.setPackage(target);
        intent.putExtra("sticker_pack_id", pack.id);
        intent.putExtra("sticker_pack_authority", BuildConfig.CONTENT_PROVIDER_AUTHORITY);
        intent.putExtra("sticker_pack_name", pack.name);
        pendingPackName = pack.name;
        pendingPackId = pack.id;
        try {
            startActivityForResult(intent, REQUEST_ADD_PACK);
        } catch (ActivityNotFoundException e) {
            sendAddResult(false, "The sticker is saved, but WhatsApp did not open: " + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == REQUEST_PICK_MEDIA) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null) {
                openIncoming(data.getData(), null);
            }
            return;
        }
        if (requestCode == REQUEST_PICK_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        if (requestCode != REQUEST_ADD_PACK) {
            return;
        }
        if (resultCode == RESULT_OK) {
            String packId = pendingPackId;
            io.execute(() -> {
                try {
                    StickerStore.markUpdated(this, packId);
                } catch (IOException ignored) {
                    // The pack stays marked, so the next update sends it again.
                }
            });
            if (updating) {
                openNextUpdate();
            } else {
                sendAddResult(true, "Added to \"" + pendingPackName + "\" in WhatsApp.");
            }
            return;
        }
        String error = data == null ? null : data.getStringExtra("validation_error");
        if (updating) {
            updating = false;
            updateQueue.clear();
            sendAddResult(false, error != null
                    ? "WhatsApp rejected the pack: " + error
                    : "WhatsApp closed before you tapped Add. Tap Update WhatsApp to try again.");
            return;
        }
        sendAddResult(false, error != null
                ? "WhatsApp rejected the pack: " + error
                : "The sticker is saved, but you closed WhatsApp before you tapped Add. Add the next sticker to try again.");
    }

    /** Sends every changed pack to WhatsApp, one Add screen at a time. */
    private void startUpdate() {
        updateQueue.clear();
        List<String> emptied = new ArrayList<>();
        for (StickerStore.Pack pack : StickerStore.allPacks(this)) {
            if (!pack.needsUpdate) {
                continue;
            }
            if (pack.stickers.isEmpty()) {
                // WhatsApp rejects a pack with no stickers, so the user removes it there.
                emptied.add(pack.name);
                io.execute(() -> {
                    try {
                        StickerStore.markUpdated(this, pack.id);
                    } catch (IOException ignored) {
                        // Shown again next time, which is harmless.
                    }
                });
            } else {
                updateQueue.add(pack.id);
            }
        }
        updateNote = emptied.isEmpty()
                ? ""
                : " \"" + String.join("\", \"", emptied) + "\" has no stickers left, so remove it in WhatsApp:"
                + " open the sticker tray, tap the settings icon, then My stickers.";
        updating = true;
        openNextUpdate();
    }

    private void openNextUpdate() {
        while (!updateQueue.isEmpty()) {
            StickerStore.Pack pack = StickerStore.find(this, updateQueue.poll());
            if (pack != null && !pack.stickers.isEmpty()) {
                openWhatsApp(pack);
                return;
            }
        }
        updating = false;
        sendAddResult(true, ("WhatsApp is up to date." + updateNote).trim());
    }

    /** Serves saved stickers to the Your stickers screen, as /stickers/PACK_ID/FILE. */
    private WebResourceResponse serveStickerFile(String path) {
        String[] parts = path.split("/");
        if (parts.length != 2 || !PackPlanner.isSafeFileName(parts[1])
                || !StickerStore.stickers(this, parts[0]).contains(parts[1])) {
            return null;
        }
        File file = new File(StickerStore.packDir(this, parts[0]), parts[1]);
        try {
            return new WebResourceResponse("image/webp", null, new FileInputStream(file));
        } catch (IOException e) {
            return null;
        }
    }

    /** Prefers regular WhatsApp, then WhatsApp Business. */
    private String whatsAppPackage() {
        for (String pkg : new String[]{"com.whatsapp", "com.whatsapp.w4b"}) {
            try {
                getPackageManager().getPackageInfo(pkg, 0);
                return pkg;
            } catch (PackageManager.NameNotFoundException ignored) {
                // Try the next one.
            }
        }
        return null;
    }

    /** Methods the editor calls. They run on a WebView thread, so they hop to the main thread or the io thread. */
    private final class Bridge {

        /** Every saved sticker, grouped by pack, as JSON. */
        @JavascriptInterface
        public String listStickers() {
            try {
                JSONArray packs = new JSONArray();
                for (StickerStore.Pack pack : StickerStore.allPacks(MainActivity.this)) {
                    JSONArray stickers = new JSONArray();
                    for (String file : pack.stickers) {
                        stickers.put(new JSONObject()
                                .put("file", file)
                                .put("url", "https://" + HOST + "/stickers/" + pack.id + "/" + file));
                    }
                    packs.put(new JSONObject()
                            .put("id", pack.id)
                            .put("name", pack.name)
                            .put("animated", pack.animated)
                            .put("needsUpdate", pack.needsUpdate)
                            .put("stickers", stickers));
                }
                return new JSONObject().put("packs", packs).toString();
            } catch (JSONException e) {
                return "{\"packs\":[]}";
            }
        }

        @JavascriptInterface
        public String deleteSticker(String packId, String file) {
            try {
                StickerStore.deleteSticker(MainActivity.this, packId, file);
                return new JSONObject().put("ok", true).toString();
            } catch (IOException | JSONException e) {
                return "{\"ok\":false,\"message\":" + JSONObject.quote(String.valueOf(e.getMessage())) + "}";
            }
        }

        @JavascriptInterface
        public void updateWhatsApp() {
            main.post(MainActivity.this::startUpdate);
        }

        @JavascriptInterface
        public void pickFile() {
            main.post(MainActivity.this::pickMedia);
        }

        /** The installed version, such as "0.1.12". */
        @JavascriptInterface
        public String appVersion() {
            return BuildConfig.VERSION_NAME;
        }

        /** Asks GitHub now and reports the answer through onUpdateCheck. */
        @JavascriptInterface
        public void checkForUpdate() {
            UpdateChecker.checkNow(MainActivity.this, latest -> main.post(() -> {
                try {
                    JSONObject result = new JSONObject()
                            .put("ok", latest > 0)
                            .put("newer", latest > BuildConfig.VERSION_CODE)
                            .put("latest", latest > 0 ? UpdateChecker.versionName(latest) : JSONObject.NULL);
                    callEditor("onUpdateCheck", result.toString());
                } catch (JSONException e) {
                    throw new IllegalStateException(e);
                }
            }));
        }

        /** Opens the latest APK in the browser, which downloads it. Android then offers to install it. */
        @JavascriptInterface
        public void openUpdate() {
            main.post(() -> {
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(UpdateChecker.DOWNLOAD_URL)));
                } catch (ActivityNotFoundException e) {
                    sendAddResult(false, "No browser could open the download: " + e.getMessage());
                }
            });
        }

        @JavascriptInterface
        public void openLink(String url) {
            main.post(() -> MainActivity.this.openLink(url));
        }

        @JavascriptInterface
        public void cancelLink() {
            links.cancel();
        }

        @JavascriptInterface
        public void ready() {
            main.post(() -> {
                editorReady = true;
                deliverShare();
            });
        }

        @JavascriptInterface
        public void addSticker(String base64, boolean animated) {
            io.execute(() -> {
                try {
                    byte[] webp = Base64.getDecoder().decode(base64);
                    StickerStore.Pack pack = StickerStore.addSticker(MainActivity.this, webp, animated);
                    main.post(() -> openWhatsApp(pack));
                } catch (IOException | IllegalArgumentException e) {
                    main.post(() -> sendAddResult(false, "Could not save the sticker: " + e.getMessage()));
                }
            });
        }

        @JavascriptInterface
        public void removeBackground(String id, String jpegBase64) {
            io.execute(() -> {
                Bitmap photo = null;
                try {
                    byte[] jpeg = Base64.getDecoder().decode(jpegBase64);
                    photo = BitmapFactory.decodeByteArray(jpeg, 0, jpeg.length);
                } catch (IllegalArgumentException ignored) {
                    // Handled below as an unreadable photo.
                }
                if (photo == null) {
                    main.post(() -> sendBackgroundResult(id, false, "message", "Could not read the photo."));
                    return;
                }
                Bitmap input = photo;
                main.post(() -> remover.remove(input, new BackgroundRemover.Callback() {
                    @Override
                    public void onProgress(String message) {
                        main.post(() -> sendBackgroundProgress(id, message));
                    }

                    @Override
                    public void onMask(Bitmap mask, long modelMs) {
                        // Runs on the io thread.
                        try {
                            String url = "https://" + HOST + "/work/" + saveMask(mask);
                            main.post(() -> sendMaskResult(id, url, modelMs));
                        } catch (IOException e) {
                            main.post(() -> sendBackgroundResult(id, false, "message", e.getMessage()));
                        }
                    }

                    @Override
                    public void onError(String message) {
                        main.post(() -> sendBackgroundResult(id, false, "message", message));
                    }
                }));
            });
        }
    }
}
