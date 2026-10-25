package com.fluxa.transfer;

import android.content.Intent;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Custom plugins must be registered before BridgeActivity creates the
        // WebView; it forwards the initial launch Intent via onNewIntent().
        registerPlugin(FluxaIncomingSharePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (intent != null && (Intent.ACTION_SEND.equals(intent.getAction()) ||
                Intent.ACTION_SEND_MULTIPLE.equals(intent.getAction()))) {
            // Capacitor already forwarded the share to the plugin. Do not
            // replay the same temporary URI grant on Activity recreation.
            setIntent(new Intent(Intent.ACTION_MAIN));
        } else if (intent != null) {
            setIntent(intent); // keep the existing pairing deep-link behavior
        }
    }
}
