package io.github.luisfetoga2.stickers;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Bundle;
import android.util.TypedValue;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.IOException;

/** Test screen: adds the sample packs to WhatsApp and reports what WhatsApp answers. */
public class MainActivity extends Activity {

    private static final int REQUEST_ADD_PACK = 200;

    private TextView status;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int pad = dp(20);
        LinearLayout column = new LinearLayout(this);
        column.setOrientation(LinearLayout.VERTICAL);
        column.setPadding(pad, pad, pad, pad);

        TextView title = new TextView(this);
        title.setText("Sticker Bridge test");
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        column.addView(title);

        TextView intro = new TextView(this);
        intro.setText("Each button asks WhatsApp to add a test pack. "
                + "After you add one, open a chat, tap the sticker icon, and look for the pack.");
        intro.setPadding(0, dp(8), 0, dp(16));
        column.addView(intro);

        column.addView(button("Add static pack (3 stickers)", () -> addPack(StickerStore.STATIC_PACK)));
        column.addView(button("Add animated pack (3 stickers)", () -> addPack(StickerStore.ANIMATED_PACK)));
        column.addView(button("Put a 4th sticker in the static pack", this::addExtraSticker));

        status = new TextView(this);
        status.setPadding(0, dp(16), 0, 0);
        status.setTextIsSelectable(true);
        column.addView(status);

        ScrollView scroll = new ScrollView(this);
        scroll.addView(column);
        setContentView(scroll);

        try {
            StickerStore.installSamples(this);
            show("Ready. WhatsApp installed: " + whatsAppPackage());
        } catch (IOException e) {
            show("Could not copy the sample stickers: " + e.getMessage());
        }
    }

    private void addPack(String packId) {
        String target = whatsAppPackage();
        if (target == null) {
            show("WhatsApp is not installed.");
            return;
        }
        Intent intent = new Intent("com.whatsapp.intent.action.ENABLE_STICKER_PACK");
        intent.setPackage(target);
        intent.putExtra("sticker_pack_id", packId);
        intent.putExtra("sticker_pack_authority", BuildConfig.CONTENT_PROVIDER_AUTHORITY);
        intent.putExtra("sticker_pack_name", StickerStore.packName(packId));
        try {
            startActivityForResult(intent, REQUEST_ADD_PACK);
        } catch (ActivityNotFoundException e) {
            show("WhatsApp did not accept the request: " + e.getMessage());
        }
    }

    private void addExtraSticker() {
        try {
            boolean added = StickerStore.addExtraSticker(this);
            show(added
                    ? "Added a green NEW sticker to the static pack. Check the pack in WhatsApp first. "
                    + "If NEW is missing, tap \"Add static pack\" again."
                    : "The 4th sticker is already in the static pack.");
        } catch (IOException e) {
            show("Could not add the sticker: " + e.getMessage());
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQUEST_ADD_PACK) {
            return;
        }
        if (resultCode == RESULT_OK) {
            show("WhatsApp says the pack was added.");
            return;
        }
        String error = data == null ? null : data.getStringExtra("validation_error");
        show(error != null
                ? "WhatsApp rejected the pack: " + error
                : "WhatsApp closed without adding the pack (cancelled, or it was already added).");
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

    private Button button(String label, Runnable onClick) {
        Button button = new Button(this);
        button.setText(label);
        button.setAllCaps(false);
        button.setOnClickListener(v -> onClick.run());
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        params.bottomMargin = dp(8);
        button.setLayoutParams(params);
        return button;
    }

    private void show(String message) {
        status.setText(message);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
