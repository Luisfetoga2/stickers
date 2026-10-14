package io.github.luisfetoga2.stickers;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

/** Pack rules with no Android code, so plain JUnit tests can cover them. */
final class PackPlanner {

    /** WhatsApp rejects packs with fewer stickers than this. */
    static final int MIN_STICKERS = 3;
    /** WhatsApp rejects packs with more stickers than this. */
    static final int MAX_STICKERS = 30;

    static final String FILLER_PREFIX = "fill";

    private static final Pattern SAFE_NAME = Pattern.compile("[A-Za-z0-9_-]+\\.(webp|png)");

    private PackPlanner() {
    }

    /**
     * The file names WhatsApp sees. When a pack has fewer than 3 real stickers,
     * copies of the first sticker fill the gap, named "fill1_<first>", "fill2_<first>".
     */
    static List<String> providerEntries(List<String> real) {
        List<String> entries = new ArrayList<>(real);
        for (int i = 1; !real.isEmpty() && entries.size() < MIN_STICKERS; i++) {
            entries.add(FILLER_PREFIX + i + "_" + real.get(0));
        }
        return entries;
    }

    /** Maps a name from providerEntries back to the real file, or returns null for an unknown name. */
    static String resolveFile(String entry, List<String> real) {
        if (!isSafeFileName(entry)) {
            return null;
        }
        if (real.contains(entry)) {
            return entry;
        }
        if (entry.startsWith(FILLER_PREFIX) && providerEntries(real).contains(entry)) {
            return real.get(0);
        }
        return null;
    }

    static boolean isFull(int realCount) {
        return realCount >= MAX_STICKERS;
    }

    static String packId(boolean animated, int number) {
        return (animated ? "animated_" : "static_") + number;
    }

    static String packName(boolean animated, int number) {
        String base = animated ? "My animated" : "My stickers";
        return number == 1 ? base : base + " " + number;
    }

    static boolean isSafeFileName(String name) {
        return name != null && SAFE_NAME.matcher(name).matches();
    }
}
