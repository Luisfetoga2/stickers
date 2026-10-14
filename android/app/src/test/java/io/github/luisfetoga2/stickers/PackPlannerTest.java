package io.github.luisfetoga2.stickers;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import org.junit.Test;

public class PackPlannerTest {

    @Test
    public void one_sticker_is_padded_to_three_with_copies() {
        assertEquals(
                Arrays.asList("a.webp", "fill1_a.webp", "fill2_a.webp"),
                PackPlanner.providerEntries(Collections.singletonList("a.webp")));
    }

    @Test
    public void two_stickers_get_one_copy() {
        assertEquals(
                Arrays.asList("a.webp", "b.webp", "fill1_a.webp"),
                PackPlanner.providerEntries(Arrays.asList("a.webp", "b.webp")));
    }

    @Test
    public void three_stickers_get_no_copies() {
        List<String> real = Arrays.asList("a.webp", "b.webp", "c.webp");
        assertEquals(real, PackPlanner.providerEntries(real));
    }

    @Test
    public void empty_pack_stays_empty() {
        assertTrue(PackPlanner.providerEntries(Collections.emptyList()).isEmpty());
    }

    @Test
    public void copies_resolve_to_the_first_sticker() {
        List<String> real = Collections.singletonList("a.webp");
        assertEquals("a.webp", PackPlanner.resolveFile("fill2_a.webp", real));
        assertEquals("a.webp", PackPlanner.resolveFile("a.webp", real));
    }

    @Test
    public void unknown_or_unsafe_names_do_not_resolve() {
        List<String> real = Arrays.asList("a.webp", "b.webp", "c.webp");
        assertNull(PackPlanner.resolveFile("fill1_a.webp", real));
        assertNull(PackPlanner.resolveFile("../a.webp", real));
        assertNull(PackPlanner.resolveFile("d.webp", real));
        assertNull(PackPlanner.resolveFile(null, real));
    }

    @Test
    public void pack_is_full_at_thirty() {
        assertFalse(PackPlanner.isFull(29));
        assertTrue(PackPlanner.isFull(30));
        List<String> thirty = new ArrayList<>();
        for (int i = 0; i < 30; i++) {
            thirty.add("s" + i + ".webp");
        }
        assertEquals(30, PackPlanner.providerEntries(thirty).size());
    }

    @Test
    public void pack_ids_and_names_count_up() {
        assertEquals("static_1", PackPlanner.packId(false, 1));
        assertEquals("animated_2", PackPlanner.packId(true, 2));
        assertEquals("My stickers", PackPlanner.packName(false, 1));
        assertEquals("My animated 3", PackPlanner.packName(true, 3));
    }

    @Test
    public void safe_names_are_simple() {
        assertTrue(PackPlanner.isSafeFileName("s1729000000000.webp"));
        assertTrue(PackPlanner.isSafeFileName("tray.png"));
        assertFalse(PackPlanner.isSafeFileName(".hidden.webp"));
        assertFalse(PackPlanner.isSafeFileName("a/b.webp"));
        assertFalse(PackPlanner.isSafeFileName("a.txt"));
    }
}
