package io.github.luisfetoga2.stickers;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.Message;
import android.os.Messenger;
import android.os.RemoteException;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The app's side of MagicTouchService. It starts the service on demand and stops it when idle.
 * When the service process dies, it reads Android's record of why and tells the user.
 */
final class MagicTouchClient {

    interface Callback {
        void onProgress(String message);

        void onMask(byte[] packed, int width, int height, long modelMs, int count, int chosen);

        void onError(String message);
    }

    private static final long IDLE_STOP_MS = 2 * 60 * 1000;
    /** Android writes the exit record a moment after the process dies. */
    private static final long EXIT_RECORD_WAIT_MS = 800;

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Callback> pending = new HashMap<>();
    private final List<Runnable> waiting = new ArrayList<>();
    private final Messenger replies = new Messenger(new Handler(Looper.getMainLooper(), this::onReply));
    private final Runnable stopWhenIdle = this::unbind;

    private Messenger service;
    private boolean bound;

    private final ServiceConnection connection = new ServiceConnection() {
        @Override
        public void onServiceConnected(ComponentName name, IBinder binder) {
            service = new Messenger(binder);
            List<Runnable> ready = new ArrayList<>(waiting);
            waiting.clear();
            for (Runnable r : ready) {
                r.run();
            }
        }

        @Override
        public void onServiceDisconnected(ComponentName name) {
            serviceDied();
        }

        @Override
        public void onBindingDied(ComponentName name) {
            serviceDied();
        }
    };

    MagicTouchClient(Context context) {
        this.context = context.getApplicationContext();
    }

    /** points holds normalized x, y pairs, labels one label per point. See MagicTouch.segment. */
    void segment(String id, byte[] jpeg, float[] points, float[] labels, boolean largest, boolean all,
                 Callback callback) {
        main.removeCallbacks(stopWhenIdle);
        pending.put(id, callback);
        Runnable send = () -> {
            Message message = Message.obtain(null, MagicTouchService.MSG_SEGMENT);
            Bundle bundle = new Bundle();
            bundle.putString("id", id);
            bundle.putByteArray("jpeg", jpeg);
            bundle.putFloatArray("points", points);
            bundle.putFloatArray("labels", labels);
            bundle.putBoolean("largest", largest);
            bundle.putBoolean("all", all);
            message.setData(bundle);
            message.replyTo = replies;
            try {
                service.send(message);
            } catch (RemoteException e) {
                serviceDied();
            }
        };
        if (service != null) {
            send.run();
        } else {
            waiting.add(send);
            if (!bound) {
                bound = context.bindService(new Intent(context, MagicTouchService.class), connection,
                        Context.BIND_AUTO_CREATE);
                if (!bound) {
                    fail("Magic Touch could not start.");
                }
            }
        }
    }

    void close() {
        main.removeCallbacks(stopWhenIdle);
        unbind();
    }

    private boolean onReply(Message message) {
        Bundle b = message.getData();
        String id = b.getString("id");
        switch (message.what) {
            case MagicTouchService.MSG_PROGRESS: {
                Callback callback = pending.get(id);
                if (callback != null) {
                    callback.onProgress(b.getString("message"));
                }
                return true;
            }
            case MagicTouchService.MSG_MASK: {
                Callback callback = pending.remove(id);
                if (callback != null) {
                    callback.onMask(b.getByteArray("mask"), b.getInt("width"), b.getInt("height"), b.getLong("ms"),
                            b.getInt("count"), b.getInt("chosen"));
                }
                stopLaterIfIdle();
                return true;
            }
            case MagicTouchService.MSG_ERROR: {
                Callback callback = pending.remove(id);
                if (callback != null) {
                    callback.onError(b.getString("message"));
                }
                stopLaterIfIdle();
                return true;
            }
            default:
                return false;
        }
    }

    /** The service process died. Android's exit record says why, and the message shows it. */
    private void serviceDied() {
        unbind();
        // Fail only the requests that were running, not ones that start while Android writes the record.
        List<Callback> lost = new ArrayList<>(pending.values());
        pending.clear();
        waiting.clear();
        main.postDelayed(() -> {
            ExitReasons.Exit exit = ExitReasons.lastExit(context, ":magic");
            String why = exit == null ? "Android gave no reason" : exit.summary;
            String message = "Magic Touch stopped (" + why + "). Mark the object again.";
            for (Callback callback : lost) {
                callback.onError(message);
            }
        }, EXIT_RECORD_WAIT_MS);
    }

    private void fail(String message) {
        List<Callback> callbacks = new ArrayList<>(pending.values());
        pending.clear();
        waiting.clear();
        for (Callback callback : callbacks) {
            callback.onError(message);
        }
    }

    private void stopLaterIfIdle() {
        if (pending.isEmpty()) {
            main.postDelayed(stopWhenIdle, IDLE_STOP_MS);
        }
    }

    private void unbind() {
        if (bound) {
            try {
                context.unbindService(connection);
            } catch (IllegalArgumentException ignored) {
                // Already unbound.
            }
        }
        bound = false;
        service = null;
    }
}
