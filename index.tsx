import { registerRootComponent } from "expo";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { BackHandler, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { createActivityRepository, type ActivityCreationBlocker } from "./src/data/activities.ts";
import { getLocalDatabase } from "./src/data/database.ts";
import type { QuickSplitPreview } from "./src/services/quickSplitEditor.ts";
import { ActivityDetailScreen } from "./src/ui/ActivityDetailScreen.tsx";
import { ActivityListScreen } from "./src/ui/ActivityListScreen.tsx";
import { ActivityMembersScreen } from "./src/ui/ActivityMembersScreen.tsx";
import { ActivitySettlementScreen } from "./src/ui/ActivitySettlementScreen.tsx";
import { ActivityQuotaSheet } from "./src/ui/ActivityQuotaSheet.tsx";
import { CreateActivityScreen } from "./src/ui/CreateActivityScreen.tsx";
import { CreateExpenseScreen } from "./src/ui/CreateExpenseScreen.tsx";
import { HomeScreen } from "./src/ui/HomeScreen.tsx";
import { QuickHistoryListScreen, QuickHistoryScreen } from "./src/ui/QuickHistoryScreen.tsx";
import { QuickSplitConversionScreen } from "./src/ui/QuickSplitConversionScreen.tsx";
import { QuickSplitResultScreen } from "./src/ui/QuickSplitResultScreen.tsx";
import { QuickSplitScreen } from "./src/ui/QuickSplitScreen.tsx";
import { colors, Icon, type IconName } from "./src/ui/visuals.tsx";

const tabs = [
  { name: "home", title: "首頁", icon: "home" },
  { name: "activities", title: "活動", icon: "calendar" },
  { name: "records", title: "記錄", icon: "records" },
] as const satisfies readonly { name: string; title: string; icon: IconName }[];

type Tab = typeof tabs[number]["name"];
type ActivityOrigin = "home" | "activities";

const tabColors = {
  shell: "#FFFFFFF0",
  border: "#E8E8E8",
  selectedBackground: "#F0F0F0",
  selected: "#202020",
  unselected: "#898989",
} as const;

const placeholderTitles = {
  settings: "設定",
};

type Destination = keyof typeof placeholderTitles;
type QuickHistoryRoute = { name: "quickHistory"; id: string; origin?: "records" };
type QuickResultRoute = { name: "quickResult"; result: QuickSplitPreview };
type ActivityDetailRoute = {
  name: "activityDetails";
  id: string;
  origin?: ActivityOrigin;
  resumeCreation?: boolean;
  previous?: ActivityDetailRoute | QuickHistoryRoute;
};
type Route =
  | { name: Tab | "settings" }
  | { name: "createActivity"; origin: ActivityOrigin }
  | { name: "createExpense"; previous: ActivityDetailRoute }
  | { name: "activityMembers"; previous: ActivityDetailRoute }
  | { name: "activitySettlement"; previous: ActivityDetailRoute }
  | { name: "quickSplit"; focusPayer?: boolean }
  | QuickResultRoute
  | QuickHistoryRoute
  | { name: "quickConversion"; historyId: string; previous: QuickHistoryRoute | QuickResultRoute }
  | ActivityDetailRoute;

function backRoute(route: Route): Route {
  if (route.name === "quickResult") return { name: "quickSplit" };
  if (route.name === "quickHistory") return { name: route.origin ?? "home" };
  if (route.name === "quickConversion") return route.previous;
  if (route.name === "createExpense" || route.name === "activityMembers" || route.name === "activitySettlement") return route.previous;
  if (route.name === "activityDetails" && route.previous) return route.previous;
  if (route.name === "activityDetails" && route.resumeCreation) {
    return { name: "createActivity", origin: route.origin ?? "home" };
  }
  if (route.name === "activityDetails" || route.name === "createActivity") {
    return { name: route.origin ?? "home" };
  }
  return { name: "home" };
}

function TabBar({ active, onSelect }: { active: Tab; onSelect: (tab: Tab) => void }) {
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={styles.tabDock}>
      <View accessibilityRole="tablist" style={styles.tabCapsule}>
        {tabs.map(({ name, title, icon }) => {
          const selected = active === name;
          return (
            <Pressable
              key={name}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => onSelect(name)}
              style={({ pressed }) => [styles.tab, selected && styles.selectedTab, pressed && styles.pressed]}
            >
              <Icon name={icon} size={26} filled={selected} color={selected ? tabColors.selected : tabColors.unselected} />
              <Text style={[styles.tabText, selected && styles.selectedTabText]}>{title}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

function Placeholder({ name, onBack }: {
  name: Destination; onBack?: () => void;
}) {
  return (
    <View style={styles.placeholder}>
      {onBack && (
        <Pressable accessibilityRole="button" onPress={onBack} style={({ pressed }) => [styles.back, pressed && styles.pressed]}>
          <Icon name="back" size={20} color={colors.accentText} />
          <Text style={styles.selectedText}>返回首頁</Text>
        </Pressable>
      )}
      <Text accessibilityRole="header" style={styles.placeholderTitle}>{placeholderTitles[name]}</Text>
      <Text style={styles.placeholderBody}>此頁面仍在開發中。</Text>
    </View>
  );
}

function App() {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [creationBlocker, setCreationBlocker] = useState<ActivityCreationBlocker | null>(null);
  const entryCheck = useRef<object>(undefined);
  const isHome = route.name === "home";
  const quickRoute = route.name === "quickConversion" ? route.previous : route;
  const inQuickSplit = quickRoute.name === "quickSplit" || quickRoute.name === "quickResult";
  const isQuickResult = quickRoute.name === "quickResult";
  const activeTab = tabs.find((tab) => tab.name === route.name)?.name;
  const activityRoute = route.name === "createExpense" || route.name === "activityMembers" || route.name === "activitySettlement" ? route.previous : route;
  const createOrigin = activityRoute.name === "createActivity" || (activityRoute.name === "activityDetails" && activityRoute.resumeCreation)
    ? activityRoute.origin ?? "home" : undefined;
  const activityDetails = route.name === "activityDetails" ? (
    <ActivityDetailScreen
      key={route.id} activityId={route.id} onBack={() => setRoute(backRoute)}
      onViewExisting={({ id }) => setRoute({
        name: "activityDetails", id, origin: route.origin, resumeCreation: route.resumeCreation, previous: route,
      })}
      onAddExpense={() => setRoute({ name: "createExpense", previous: route })}
      onManageMembers={() => setRoute({ name: "activityMembers", previous: route })}
      onViewSettlement={() => setRoute({ name: "activitySettlement", previous: route })}
    />
  ) : route.name === "createExpense" ? (
    <CreateExpenseScreen key={route.previous.id} activityId={route.previous.id}
      onBack={() => setRoute(route.previous)} onSaved={() => setRoute(route.previous)} />
  ) : route.name === "activityMembers" ? (
    <ActivityMembersScreen key={route.previous.id} activityId={route.previous.id} onBack={() => setRoute(route.previous)} />
  ) : route.name === "activitySettlement" ? (
    <ActivitySettlementScreen key={route.previous.id} activityId={route.previous.id} onBack={() => setRoute(route.previous)} />
  ) : null;
  const conversion = route.name === "quickConversion" ? (
    <QuickSplitConversionScreen key={route.historyId} historyId={route.historyId}
      onBack={() => setRoute(route.previous)} onJoined={(id) => setRoute({ name: "activityDetails", id,
        previous: route.previous.name === "quickHistory" ? route.previous : { name: "quickHistory", id: route.historyId },
      })} />
  ) : null;

  useLayoutEffect(() => {
    entryCheck.current = undefined;
    return () => { entryCheck.current = undefined; };
  }, [route]);

  async function startActivityCreation(origin: ActivityOrigin) {
    if (entryCheck.current) return;
    const request = {};
    entryCheck.current = request;
    let blocker: ActivityCreationBlocker | null = null;
    try {
      blocker = await createActivityRepository(await getLocalDatabase()).getCreationBlocker();
    } catch {
      // The form can still open. Its transaction will enforce eligibility and report storage failures.
    }
    if (entryCheck.current !== request) return;
    entryCheck.current = undefined;
    if (blocker) setCreationBlocker(blocker);
    else setRoute({ name: "createActivity", origin });
  }

  function openExistingActivity(blocker: ActivityCreationBlocker) {
    setCreationBlocker(null);
    setRoute({
      name: "activityDetails", id: blocker.id,
      origin: createOrigin ?? (route.name === "activities" ? "activities" : "home"),
      resumeCreation: route.name === "createActivity",
    });
  }

  useEffect(() => {
    if (isHome) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setRoute(backRoute);
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
            onCreateActivity={() => { void startActivityCreation("home"); }}
            onActivities={() => setRoute({ name: "activities" })}
            onRecords={() => setRoute({ name: "records" })}
            onActivity={(activity) => setRoute({ name: "activityDetails", id: activity.id })}
            onRecord={(record) => setRoute(record.kind === "activity"
              ? { name: "activityDetails", id: record.id }
              : { name: "quickHistory", id: record.id })}
          />
        ) : route.name === "activities" ? (
          <ActivityListScreen
            onCreate={() => { void startActivityCreation("activities"); }}
            onActivity={({ id }) => setRoute({ name: "activityDetails", id, origin: "activities" })}
          />
        ) : route.name === "records" ? (
          <QuickHistoryListScreen onRecord={(id) => setRoute({ name: "quickHistory", id, origin: "records" })} />
        ) : route.name === "createActivity" || createOrigin !== undefined ? (
          <>
            <View style={route.name === "createActivity" ? styles.main : styles.hidden}>
              <CreateActivityScreen
                onBack={() => setRoute(backRoute)}
                onBlocked={setCreationBlocker}
                onCreated={({ id }) => setRoute({ name: "activityDetails", id, origin: "activities" })}
              />
            </View>
            {activityDetails}
          </>
        ) : activityDetails ? (
          activityDetails
        ) : inQuickSplit ? (
          <>
            <View style={isQuickResult ? styles.hidden : styles.main}>
              <QuickSplitScreen
                onBack={() => setRoute({ name: "home" })}
                onResult={(result) => setRoute({ name: "quickResult", result })}
                focusPayer={route.name === "quickSplit" && route.focusPayer}
              />
            </View>
            {isQuickResult && (
              <View style={conversion ? styles.hidden : styles.main}>
                <QuickSplitResultScreen
                  preview={quickRoute.result}
                  onBack={() => setRoute({ name: "quickSplit" })}
                  onAddPayer={() => setRoute({ name: "quickSplit", focusPayer: true })}
                  onConvert={(historyId) => setRoute({ name: "quickConversion", historyId, previous: quickRoute })}
                />
              </View>
            )}
            {conversion}
          </>
        ) : route.name === "quickHistory" ? (
          <QuickHistoryScreen key={route.id} historyId={route.id} onBack={() => setRoute(backRoute)}
            onConvert={() => setRoute({ name: "quickConversion", historyId: route.id, previous: route })}
            onViewActivity={(id) => setRoute({ name: "activityDetails", id, previous: route })} />
        ) : route.name === "quickConversion" ? (
          conversion
        ) : route.name === "settings" ? (
          <Placeholder
            name={route.name}
            onBack={activeTab ? undefined : () => setRoute(backRoute)}
          />
        ) : null}
      </SafeAreaView>
      {activeTab && <TabBar active={activeTab} onSelect={(tab) => setRoute({ name: tab })} />}
      {creationBlocker && <ActivityQuotaSheet blocker={creationBlocker}
        onClose={() => setCreationBlocker(null)} onView={() => openExistingActivity(creationBlocker)} />}
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  app: { flex: 1, backgroundColor: colors.page },
  main: { flex: 1 },
  hidden: { display: "none" },
  tabDock: { paddingHorizontal: 24, paddingTop: 8, paddingBottom: 10 },
  tabCapsule: {
    width: "100%", maxWidth: 480, alignSelf: "center", flexDirection: "row", gap: 4, padding: 5,
    backgroundColor: tabColors.shell, borderColor: tabColors.border, borderWidth: 1, borderRadius: 999,
    boxShadow: "0 4px 14px rgba(32, 32, 32, 0.10)",
  },
  tab: {
    flex: 1, minHeight: 57, minWidth: 44, paddingVertical: 5, paddingHorizontal: 4, borderRadius: 999,
    alignItems: "center", justifyContent: "center", gap: 4,
  },
  selectedTab: { backgroundColor: tabColors.selectedBackground },
  tabText: { color: tabColors.unselected, fontSize: 14, textAlign: "center" },
  selectedTabText: { color: tabColors.selected, fontWeight: "600" },
  selectedText: { color: colors.accentText, fontWeight: "600" },
  pressed: { opacity: 0.65 },
  placeholder: { width: "100%", maxWidth: 620, alignSelf: "center", paddingHorizontal: 26, paddingTop: 18, gap: 10 },
  back: { minHeight: 44, alignSelf: "flex-start", flexDirection: "row", alignItems: "center", gap: 4 },
  placeholderTitle: { color: colors.ink, fontSize: 28, fontWeight: "700" },
  placeholderBody: { color: colors.muted, fontSize: 16 },
});

registerRootComponent(App);
