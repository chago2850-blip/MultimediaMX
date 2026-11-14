/*
 * MultimediaMX — Copyright (C) 2026 Santiago Miguel — GPL-3.0-or-later
 */
package mx.multimediamx.player;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(MediaLibraryPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
