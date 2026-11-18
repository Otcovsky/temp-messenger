package tech.tempmessenger.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import tech.tempmessenger.app.push.TmPushPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(TmPushPlugin.class); // свои плагины регистрируются до super.onCreate
        super.onCreate(savedInstanceState);
    }
}
