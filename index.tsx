import { registerRootComponent } from "expo";
import { useEffect, useState } from "react";
import { BackHandler, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { HomeScreen } from "./src/ui/HomeScreen.tsx";
import { colors, Icon, type IconName } from "./src/ui/visuals.tsx";

const tabs = [
  { name: "home", title: "首頁", icon: "home" },
  { name: "activities", title: "活動", icon: "calendar" },
  { name: "records", title: "記錄", icon: "records" },
] as const satisfies readonly { name: string; title: string; icon: IconName }[];

type Tab = typeof tabs[number]["name"];

const placeholderTitles = {
  activities: "活動",
  records: "記錄",
  quickSplit: "快速分帳",
  createActivity: "建立活動",
  activityDetails: "活動詳情",
  quickHistory: "快速計算記錄",
  settings: "設定",
};

type Destination = keyof typeof placeholderTitles;
type Route =
  | { name: Tab | "quickSplit" | "createActivity" | "settings" }
  | { name: "activityDetails"; id: string; title: string }
  | { name: "quickHistory"; id: string };

function TabBar({ active, onSelect }: { active: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={styles.tabSurface}>
      <View accessibilityRole="tablist" style={styles.tabBar}>
        {tabs.map(({ name, title, icon }) => {
          const selected = active === name;
          return (
            <Pressable
              key={name}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onSelect(name)}
              style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
            >
              <Icon name={icon} size={26} filled={selected} color={selected ? colors.accent : colors.muted} />
              <Text style={[styles.tabText, selected && styles.selectedText]}>{title}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

function Placeholder({ name, context, onBack }: { name: Destination; context?: string; onBack?: () => void }) {
  return (
    <View style={styles.placeholder}>
      {onBack && (
        <Pressable accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <Icon name="back" size={20} color={colors.accentText} />
          <Text style={styles.selectedText}>返回首頁</Text>
        </Pressable>
      )}
      <Text accessibilityRole="header" style={styles.placeholderTitle}>{placeholderTitles[name]}</Text>
      {context && <Text style={styles.placeholderContext}>{context}</Text>}
      <Text style={styles.placeholderBody}>此頁面仍在開發中。</Text>
    </View>
  );
}

function App() {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const isHome = route.name === "home";
  const activeTab = tabs.find((tab) => tab.name === route.name)?.name;
  const detailId = "id" in route ? route.id : undefined;

  useEffect(() => {
    if (isHome) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setRoute({ name: "home" });
      return true;
    });
    return () => subscription.remove();
  }, [isHome]);

  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.app}>
      <StatusBar barStyle="dark-content" />
      <SafeAreaView edges={activeTab ? ["top", "left", "right"] : ["top", "bottom", "left", "right"]} style={styles.main}>
        {route.name === "home" ? (
          <HomeScreen
            onSettings={() => setRoute({ name: "settings" })}
            onQuickSplit={() => setRoute({ name: "quickSplit" })}
            onCreateActivity={() => setRoute({ name: "createActivity" })}
            onActivities={() => setRoute({ name: "activities" })}
            onRecords={() => setRoute({ name: "records" })}
            onActivity={(activity) => setRoute({ name: "activityDetails", id: activity.id, title: activity.name })}
            onRecord={(record) => setRoute(record.kind === "activity"
              ? { name: "activityDetails", id: record.id, title: record.name }
              : { name: "quickHistory", id: record.id })}
          />
        ) : (
          <Placeholder
            key={detailId === undefined ? route.name : `${route.name}:${detailId}`}
            name={route.name}
            context={route.name === "activityDetails" ? route.title : undefined}
            onBack={activeTab ? undefined : () => setRoute({ name: "home" })}
          />
        )}
      </SafeAreaView>
      {activeTab && <TabBar active={activeTab} onSelect={(tab) => setRoute({ name: tab })} />}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.page },
  main: { flex: 1 },
  tabSurface: { backgroundColor: colors.page, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.outline },
  tabBar: { width: "100%", maxWidth: 620, alignSelf: "center", flexDirection: "row", paddingTop: 6, paddingBottom: 3 },
  tab: { flex: 1, minHeight: 57, paddingVertical: 5, paddingHorizontal: 4, alignItems: "center", justifyContent: "center", gap: 4 },
  tabText: { color: colors.muted, fontSize: 14 },
  selectedText: { color: colors.accentText, fontWeight: "600" },
  pressed: { opacity: 0.65 },
  placeholder: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 26, paddingTop: 18, gap: 10 },
  back: { minHeight: 44, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 },
  placeholderTitle: { color: colors.ink, fontSize: 28, fontWeight: "700" },
  placeholderContext: { color: colors.ink, fontSize: 17, fontWeight: "600" },
  placeholderBody: { color: colors.muted, fontSize: 16 },
});

registerRootComponent(App);
