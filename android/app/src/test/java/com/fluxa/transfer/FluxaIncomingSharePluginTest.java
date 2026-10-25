package com.fluxa.transfer;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** JVM unit tests for the app-private inbound file-name boundary. */
public class FluxaIncomingSharePluginTest {
    @Test
    public void dropsDirectoryTraversalAndBackslashes() {
        assertEquals("picture.png", FluxaIncomingSharePlugin.safeName("../../folder\\picture.png", 0));
        assertEquals("shared-file-2", FluxaIncomingSharePlugin.safeName("../..", 1));
    }

    @Test
    public void replacesControlCharactersAndBoundsNameLength() {
        assertEquals("test file.txt", FluxaIncomingSharePlugin.safeName("test\u0000file.txt", 0));
        assertTrue(FluxaIncomingSharePlugin.safeName("a".repeat(300), 0).length() <= 180);
    }
}
