import { registerRootComponent } from "expo";
import { useEffect, useState } from "react";
import { Text, View } from "react-native";
import { getLocalDatabase } from "./src/data/database.ts";

function App() {
  const [status, setStatus] = useState("Opening local database…");

  useEffect(() => {
    let mounted = true;
    getLocalDatabase().then(
      () => { if (mounted) setStatus("Local database ready"); },
      (error: unknown) => {
        if (mounted) setStatus(error instanceof Error ? error.message : String(error));
      },
    );
    return () => { mounted = false; };
  }, []);

  return (
    <View style={{ flex: 1, justifyContent: "center", alignItems: "center", padding: 24 }}>
      <Text>{status}</Text>
    </View>
  );
}

registerRootComponent(App);
