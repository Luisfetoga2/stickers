package io.github.luisfetoga2.stickers;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.content.SharedPreferences;
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
 * It also remembers, in the app's own process, which delegate this phone uses and which one crashed it.
 */
final class MagicTouchClient {

    interface Callback {
        void onProgress(String message);

        void onMask(byte[] mask, int width, int height, long modelMs, String delegate, String timing);

        void onError(String message);
    }

    private static final long IDLE_STOP_MS = 2 * 60 * 1000;
    private static final String DELEGATE = "delegate";
    private static final String GPU_BAD = "gpuBad";
    private static final String CPU_BAD = "cpuBad";

    private final Context context;
    private final SharedPreferences prefs;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, Callback> pending = new HashMap<>();
    private final List<Runnable> waiting = new ArrayList<>();
    private final Messenger replies = new Messenger(new Handler(Looper.getMainLooper(), this::onReply));
    private final Runnable stopWhenIdle = this::unbind;

    private Messenger service;
    private boolean bound;
    /** The delegate the service is trying for the first time. If the service dies now, this one crashed. */
    private String probing;

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
        this.prefs = this.context.getSharedPreferences("magic_touch", Context.MODE_PRIVATE);
    }

    void segment(String id, byte[] jpeg, float[] points, Callback callback) {
        main.removeCallbacks(stopWhenIdle);
        pending.put(id, callback);
        Runnable send = () -> {
            Message message = Message.obtain(null, MagicTouchService.MSG_SEGMENT);
            Bundle bundle = new Bundle();
            bundle.putString("id", id);
            bundle.putByteArray("jpeg", jpeg);
            bundle.putFloatArray("points", points);
            bundle.putString("use", prefs.getString(DELEGATE, null));
            bundle.putBoolean("gpuBad", prefs.getBoolean(GPU_BAD, false));
            bundle.putBoolean("cpuBad", prefs.getBoolean(CPU_BAD, false));
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
            case MagicTouchService.MSG_PROBE:
                probing = b.getString("delegate");
                return true;
            case MagicTouchService.MSG_PROGRESS: {
                Callback callback = pending.get(id);
                if (callback != null) {
                    callback.onProgress(b.getString("message"));
                }
                return true;
            }
            case MagicTouchService.MSG_MASK: {
                probing = null;
                String delegate = b.getString("delegate");
                prefs.edit().putString(DELEGATE, delegate).apply();
                Callback callback = pending.remove(id);
                if (callback != null) {
                    callback.onMask(b.getByteArray("mask"), b.getInt("width"), b.getInt("height"), b.getLong("ms"),
                            delegate, b.getString("timing"));
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

    /**
     * The service process died, most likely in native code. The delegate it was trying, or the one it uses,
     * is marked as crashing this phone, and the next try uses the other one.
     */
    private void serviceDied() {
        String crashed = probing != null ? probing : prefs.getString(DELEGATE, null);
        probing = null;
        String message;
        if (crashed != null) {
            prefs.edit().putBoolean("GPU".equals(crashed) ? GPU_BAD : CPU_BAD, true).remove(DELEGATE).apply();
            String other = "GPU".equals(crashed) ? "CPU" : "GPU";
            message = "Magic Touch crashed on this phone's " + crashed + ". From now on it uses the " + other
                    + ". Mark the object again.";
        } else {
            message = "Magic Touch crashed. Mark the object again.";
        }
        unbind();
        fail(message);
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
