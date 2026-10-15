package io.github.luisfetoga2.stickers;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Reads the parts of a native crash record (Android's tombstone protobuf) that name the cause:
 * the signal, the abort message, and the top frames of the thread that crashed.
 * Field numbers come from AOSP system/core/debuggerd/proto/tombstone.proto.
 */
final class Tombstone {

    private static final int FRAMES = 6;

    private Tombstone() {
    }

    /** A short text about the crash, or "" when the bytes are not a tombstone. */
    static String summarize(byte[] data) {
        try {
            Message tombstone = Message.parse(data, 0, data.length);
            long tid = tombstone.number(6);
            List<String> parts = new ArrayList<>();

            Message signal = tombstone.message(10);
            if (signal != null) {
                String text = signal.text(2) + " " + signal.text(4);
                if (signal.number(8) != 0) {
                    text += String.format(Locale.ROOT, " at 0x%x", signal.number(9));
                }
                parts.add(text.trim());
            }
            String abort = tombstone.text(14);
            if (!abort.isEmpty()) {
                parts.add("abort: " + abort);
            }
            for (byte[] cause : tombstone.all(15)) {
                String text = Message.parse(cause, 0, cause.length).text(1);
                if (!text.isEmpty()) {
                    parts.add(text);
                }
            }
            for (byte[] entry : tombstone.all(16)) {
                Message pair = Message.parse(entry, 0, entry.length);
                Message thread = pair.message(2);
                if (thread == null || pair.number(1) != tid) {
                    continue;
                }
                StringBuilder frames = new StringBuilder("thread ").append(thread.text(2)).append(':');
                List<byte[]> backtrace = thread.all(4);
                for (int i = 0; i < Math.min(FRAMES, backtrace.size()); i++) {
                    Message frame = Message.parse(backtrace.get(i), 0, backtrace.get(i).length);
                    String file = frame.text(6);
                    file = file.substring(file.lastIndexOf('/') + 1);
                    String function = frame.text(4);
                    frames.append(' ').append('#').append(i).append(' ').append(file);
                    if (!function.isEmpty()) {
                        frames.append(' ').append(function.length() > 80 ? function.substring(0, 80) + "…" : function);
                    }
                }
                parts.add(frames.toString());
            }
            return String.join(". ", parts);
        } catch (RuntimeException e) {
            return "";
        }
    }

    /** The fields of one protobuf message, without a schema: numbers and length-delimited bytes. */
    static final class Message {
        private final List<Integer> fields = new ArrayList<>();
        private final List<Object> values = new ArrayList<>();

        static Message parse(byte[] data, int from, int to) {
            Message message = new Message();
            int[] at = {from};
            while (at[0] < to) {
                long key = varint(data, at);
                int field = (int) (key >>> 3);
                int wire = (int) (key & 7);
                Object value;
                switch (wire) {
                    case 0:
                        value = varint(data, at);
                        break;
                    case 1:
                        value = little(data, at, 8);
                        break;
                    case 2: {
                        int length = (int) varint(data, at);
                        if (length < 0 || at[0] + length > to) {
                            throw new IllegalArgumentException("bad length");
                        }
                        byte[] bytes = new byte[length];
                        System.arraycopy(data, at[0], bytes, 0, length);
                        at[0] += length;
                        value = bytes;
                        break;
                    }
                    case 5:
                        value = little(data, at, 4);
                        break;
                    default:
                        throw new IllegalArgumentException("bad wire type " + wire);
                }
                message.fields.add(field);
                message.values.add(value);
            }
            return message;
        }

        long number(int field) {
            for (int i = 0; i < fields.size(); i++) {
                if (fields.get(i) == field && values.get(i) instanceof Long) {
                    return (Long) values.get(i);
                }
            }
            return 0;
        }

        String text(int field) {
            List<byte[]> all = all(field);
            return all.isEmpty() ? "" : new String(all.get(0), StandardCharsets.UTF_8);
        }

        Message message(int field) {
            List<byte[]> all = all(field);
            return all.isEmpty() ? null : parse(all.get(0), 0, all.get(0).length);
        }

        List<byte[]> all(int field) {
            List<byte[]> found = new ArrayList<>();
            for (int i = 0; i < fields.size(); i++) {
                if (fields.get(i) == field && values.get(i) instanceof byte[]) {
                    found.add((byte[]) values.get(i));
                }
            }
            return found;
        }

        private static long varint(byte[] data, int[] at) {
            long result = 0;
            for (int shift = 0; shift < 64; shift += 7) {
                byte b = data[at[0]++];
                result |= (long) (b & 0x7F) << shift;
                if ((b & 0x80) == 0) {
                    return result;
                }
            }
            throw new IllegalArgumentException("bad varint");
        }

        private static long little(byte[] data, int[] at, int size) {
            long result = 0;
            for (int i = 0; i < size; i++) {
                result |= (long) (data[at[0]++] & 0xFF) << (8 * i);
            }
            return result;
        }
    }
}
