package io.github.luisfetoga2.stickers;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowInsets;
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

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.Base64;
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

    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private final Handler main = new Handler(Looper.getMainLooper());

    private WebView webView;
    private ValueCallback<Uri[]> fileCallback;
    private File sharedDir;
    /** MIME type of the file in sharedDir. Read on a WebView thread. */
    private volatile String sharedMime = "application/octet-stream";

    /** True after the editor called ready(). */
    private boolean editorReady;
    /** A shared file copied into the cache, waiting for the editor. */
    private JSONObject pendingShare;
    private String pendingPackName;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (getActionBar() != null) {
            getActionBar().hide();
        }
        sharedDir = new File(getCacheDir(), "shared");

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
    protected void onDestroy() {
        io.shutdown();
        webView.destroy();
        super.onDestroy();
    }

    /** Copies a shared photo into the cache, then hands its URL to the editor. */
    private void handleShare(Intent intent) {
        if (intent == null || !Intent.ACTION_SEND.equals(intent.getAction())) {
            return;
        }
        Uri uri = Build.VERSION.SDK_INT >= 33
                ? intent.getParcelableExtra(Intent.EXTRA_STREAM, Uri.class)
                : legacyStream(intent);
        if (uri == null) {
            return;
        }
        String mime = intent.getType() != null ? intent.getType() : getContentResolver().getType(uri);
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

    private void deliverShare() {
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
        try {
            startActivityForResult(intent, REQUEST_ADD_PACK);
        } catch (ActivityNotFoundException e) {
            sendAddResult(false, "The sticker is saved, but WhatsApp did not open: " + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
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
            sendAddResult(true, "Added to \"" + pendingPackName + "\" in WhatsApp.");
            return;
        }
        String error = data == null ? null : data.getStringExtra("validation_error");
        sendAddResult(false, error != null
                ? "WhatsApp rejected the pack: " + error
                : "The sticker is saved, but you closed WhatsApp before you tapped Add. Add the next sticker to try again.");
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
    }
}
