package io.github.luisfetoga2.stickers;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class UpdateCheckerTest {

    @Test
    public void build_number_comes_from_the_release_tag() {
        assertEquals(12, UpdateChecker.buildFromTag("apk-12"));
        assertEquals(130, UpdateChecker.buildFromTag("apk-130"));
    }

    @Test
    public void other_tags_have_no_build_number() {
        assertEquals(-1, UpdateChecker.buildFromTag("v1.0"));
        assertEquals(-1, UpdateChecker.buildFromTag("apk-"));
        assertEquals(-1, UpdateChecker.buildFromTag(null));
    }

    @Test
    public void version_name_matches_the_app_scheme() {
        assertEquals("0.1.13", UpdateChecker.versionName(13));
    }
}
