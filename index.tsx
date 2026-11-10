import { registerRootComponent } from "expo";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, BackHandler, Keyboard, Pressable, StatusBar, StyleSheet, Text, View } from "react-native";
import { initialWindowMetrics, SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { createActivityRepository, type ActivityCreationBlocker } from "./src/data/activities.ts";
import { DatabaseInitializationError, getLocalDatabase } from "./src/data/database.ts";
import type { TransferSuggestion } from "./src/domain/settlement.ts";
import type { AppLanguage } from "./src/services/appPreferences.ts";
import type { QuickSplitPreview } from "./src/services/quickSplitEditor.ts";
import { proEntitlement } from "./src/services/storeKitExpo.ts";
import { ActivityDetailScreen } from "./src/ui/ActivityDetailScreen.tsx";
import { ActivityListScreen } from "./src/ui/ActivityListScreen.tsx";
import { ActivityMembersScreen } from "./src/ui/ActivityMembersScreen.tsx";
import { ActivityRepaymentHistoryScreen } from "./src/ui/ActivityRepaymentHistoryScreen.tsx";
import { ActivityRepaymentScreen } from "./src/ui/ActivityRepaymentScreen.tsx";
import { ActivitySettlementPngScreen } from "./src/ui/ActivitySettlementPngScreen.tsx";
import { ActivitySettlementScreen } from "./src/ui/ActivitySettlementScreen.tsx";
import { ActivityQuotaSheet } from "./src/ui/ActivityQuotaSheet.tsx";
import { AppLanguageContext } from "./src/ui/AppLanguageContext.ts";
import { CreateActivityScreen } from "./src/ui/CreateActivityScreen.tsx";
import { CreateExpenseScreen } from "./src/ui/CreateExpenseScreen.tsx";
import { ExpenseCorrectionScreen } from "./src/ui/ExpenseCorrectionScreen.tsx";
import { HomeScreen } from "./src/ui/HomeScreen.tsx";
import { ProContext } from "./src/ui/ProContext.ts";
import { ProPaywall } from "./src/ui/ProPaywall.tsx";
import { QuickHistoryListScreen, QuickHistoryScreen } from "./src/ui/QuickHistoryScreen.tsx";
import { QuickSplitConversionScreen } from "./src/ui/QuickSplitConversionScreen.tsx";
import { QuickSplitResultScreen } from "./src/ui/QuickSplitResultScreen.tsx";
import { QuickSplitScreen } from "./src/ui/QuickSplitScreen.tsx";
import { SettingsScreen } from "./src/ui/SettingsScreen.tsx";
import { settingsCopy } from "./src/ui/settingsCopy.ts";
import { useAppPreferences } from "./src/ui/useAppPreferences.ts";
import { colors, Icon, type IconName } from "./src/ui/visuals.tsx";

const tabs = [
  { name: "home", title: { "zh-HK": "首頁", en: "Home" }, icon: "home" },
  { name: "activities", title: { "zh-HK": "活動", en: "Activities" }, icon: "calendar" },
  { name: "records", title: { "zh-HK": "記錄", en: "Records" }, icon: "records" },
] as const satisfies readonly { name: string; title: Record<AppLanguage, string>; icon: IconName }[];

type Tab = typeof tabs[number]["name"];
type ActivityOrigin = "home" | "activities";

const tabColors = {
  shell: "#FFFFFFF0",
  border: "#E8E8E8",
  selectedBackground: "#F0F0F0",
  selected: "#202020",
  unselected: "#898989",
} as const;

type QuickHistoryRoute = { name: "quickHistory"; id: string; origin?: "records" };
type QuickResultRoute = { name: "quickResult"; result: QuickSplitPreview };
type ActivityDetailRoute = {
  name: "activityDetails";
  id: string;
  origin?: ActivityOrigin;
  resumeCreation?: boolean;
  previous?: ActivityDetailRoute | QuickHistoryRoute;
};
type ActivitySettlementRoute = { name: "activitySettlement"; previous: ActivityDetailRoute; initialTab?: "overview" | "transfers" };
type Route =
  | { name: Tab }
  | { name: "settings"; restored?: boolean; recoveryRequired?: boolean }
  | { name: "createActivity"; origin: ActivityOrigin }
  | { name: "createExpense"; previous: ActivityDetailRoute }
  | { name: "expenseDetails"; expenseId: string; previous: ActivityDetailRoute }
  | { name: "activityMembers"; previous: ActivityDetailRoute }
  | ActivitySettlementRoute
  | { name: "activitySettlementPng"; previous: ActivitySettlementRoute }
  | { name: "activityRepayment"; previous: ActivitySettlementRoute; suggestion: TransferSuggestion }
  | { name: "activityRepaymentHistory"; previous: ActivitySettlementRoute }
  | { name: "quickSplit"; focusPayer?: boolean }
  | QuickResultRoute
  | QuickHistoryRoute
  | { name: "quickConversion"; historyId: string; previous: QuickHistoryRoute | QuickResultRoute }
  | ActivityDetailRoute;

function backRoute(route: Route): Route {
  if (route.name === "quickResult") return { name: "quickSplit" };
  if (route.name === "quickHistory") return { name: route.origin ?? "home" };
  if (route.name === "quickConversion") return route.previous;
  if (route.name === "createExpense" || route.name === "expenseDetails" || route.name === "activityMembers" || route.name === "activitySettlement"
    || route.name === "activityRepayment" || route.name === "activityRepaymentHistory" || route.name === "activitySettlementPng") return route.previous;
  if (route.name === "activityDetails" && route.previous) return route.previous;
  if (route.name === "activityDetails" && route.resumeCreation) {
    return { name: "createActivity", origin: route.origin ?? "home" };
  }
  if (route.name === "activityDetails" || route.name === "createActivity") {
    return { name: route.origin ?? "home" };
  }
  return { name: "home" };
}

function TabBar({ active, language, onSelect, obscured }: {
  active: Tab; language: AppLanguage; onSelect: (tab: Tab) => void; obscured: boolean;
}) {
  return (
    <SafeAreaView edges={["bottom", "left", "right"]} style={styles.tabDock}
      accessibilityElementsHidden={obscured} importantForAccessibility={obscured ? "no-hide-descendants" : "auto"}>
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
              <Text style={[styles.tabText, selected && styles.selectedTabText]}>{title[language]}</Text>
            </Pressable>
          );
        })}
      </View>
    </SafeAreaView>
  );
}

function App() {
  const settings = useAppPreferences();
  const { language, preferences } = settings;
  const [ledgerReady, setLedgerReady] = useState(false);
  const [ledgerEpoch, setLedgerEpoch] = useState(0);
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [creationBlocker, setCreationBlocker] = useState<ActivityCreationBlocker | null>(null);
  const [proOpen, setProOpen] = useState(false);
  const openPro = useCallback((restore = false) => {
    Keyboard.dismiss();
    setProOpen(true);
    void proEntitlement.loadProduct();
    if (restore) void proEntitlement.restore();
    else void proEntitlement.refresh();
  }, []);
  const closePro = useCallback(() => setProOpen(false), []);
  const entryCheck = useRef<object>(undefined);
  const isHome = route.name === "home";
  const quickRoute = route.name === "quickConversion" ? route.previous : route;
  const inQuickSplit = quickRoute.name === "quickSplit" || quickRoute.name === "quickResult";
  const isQuickResult = quickRoute.name === "quickResult";
  const activeTab = ledgerReady && preferences ? tabs.find((tab) => tab.name === route.name)?.name : undefined;
  const activityRoute = route.name === "activityRepayment" || route.name === "activityRepaymentHistory" || route.name === "activitySettlementPng" ? route.previous.previous
    : route.name === "createExpense" || route.name === "expenseDetails" || route.name === "activityMembers"
      || route.name === "activitySettlement" ? route.previous : route;
  const createOrigin = activityRoute.name === "createActivity" || (activityRoute.name === "activityDetails" && activityRoute.resumeCreation)
    ? activityRoute.origin ?? "home" : undefined;
  const activityDetails = route.name === "activityDetails" ? (
    <ActivityDetailScreen
      key={route.id} activityId={route.id} onBack={() => setRoute(backRoute)}
      onViewExisting={({ id }) => setRoute({
        name: "activityDetails", id, origin: route.origin, resumeCreation: route.resumeCreation, previous: route,
      })}
      onAddExpense={() => setRoute({ name: "createExpense", previous: route })}
      onViewExpense={(expenseId) => setRoute({ name: "expenseDetails", expenseId, previous: route })}
      onManageMembers={() => setRoute({ name: "activityMembers", previous: route })}
      onViewSettlement={(initialTab) => setRoute({ name: "activitySettlement", previous: route, initialTab })}
    />
  ) : route.name === "createExpense" ? (
    <CreateExpenseScreen key={route.previous.id} activityId={route.previous.id}
      onBack={() => setRoute(route.previous)} onSaved={() => setRoute(route.previous)} />
  ) : route.name === "expenseDetails" ? (
    <ExpenseCorrectionScreen key={route.expenseId} activityId={route.previous.id} expenseId={route.expenseId}
      onBack={() => setRoute(route.previous)}
      onViewSettlement={() => setRoute({ name: "activitySettlement", previous: route.previous })} />
  ) : route.name === "activityMembers" ? (
    <ActivityMembersScreen key={route.previous.id} activityId={route.previous.id} onBack={() => setRoute(route.previous)} />
  ) : route.name === "activitySettlement" ? (
    <ActivitySettlementScreen key={route.previous.id} activityId={route.previous.id} initialTab={route.initialTab}
      onBack={() => setRoute(route.previous)}
      onSharePng={() => setRoute({ name: "activitySettlementPng", previous: { ...route, initialTab: "overview" } })}
      onViewRepaymentHistory={(tab) => setRoute({ name: "activityRepaymentHistory",
        previous: { ...route, initialTab: tab },
      })} onRecordRepayment={(suggestion) => setRoute({ name: "activityRepayment", suggestion,
        previous: { ...route, initialTab: "transfers" },
      })} />
  ) : route.name === "activitySettlementPng" ? (
    <ActivitySettlementPngScreen key={route.previous.previous.id} activityId={route.previous.previous.id} appLocale={language}
      onBack={() => setRoute(route.previous)} />
  ) : route.name === "activityRepayment" ? (
    <ActivityRepaymentScreen key={route.previous.previous.id} activityId={route.previous.previous.id}
      suggestion={route.suggestion} onBack={() => setRoute(route.previous)} />
  ) : route.name === "activityRepaymentHistory" ? (
    <ActivityRepaymentHistoryScreen key={route.previous.previous.id} activityId={route.previous.previous.id}
      onBack={() => setRoute(route.previous)} onReturnToSettlement={() => setRoute({ ...route.previous, initialTab: "transfers" })} />
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

  useEffect(() => {
    proEntitlement.start();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") void proEntitlement.refresh();
    });
    return () => {
      subscription.remove();
      proEntitlement.stop();
    };
  }, []);

  useEffect(() => {
    let current = true;
    // Opening through the host resolves any durable restore marker before pages read the ledger.
    void getLocalDatabase().catch((error: unknown) => {
      if (current && error instanceof DatabaseInitializationError && error.stage === "recovery") {
        setRoute({ name: "settings", recoveryRequired: true });
      }
    }).finally(() => { if (current) setLedgerReady(true); });
    return () => { current = false; };
  }, []);

  function onRestored() {
    entryCheck.current = undefined;
    setCreationBlocker(null);
    setRoute({ name: "settings", restored: true });
    setLedgerEpoch((epoch) => epoch + 1);
    void proEntitlement.refresh();
  }

  async function startActivityCreation(origin: ActivityOrigin) {
    if (entryCheck.current) return;
    const request = {};
    entryCheck.current = request;
    let blocker: ActivityCreationBlocker | null = null;
    try {
      blocker = await createActivityRepository(await getLocalDatabase(), proEntitlement.hasProAccess).getCreationBlocker();
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
    if (proOpen || isHome || route.name === "settings") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setRoute(backRoute);
      return true;
    });
    return () => subscription.remove();
  }, [isHome, proOpen, route.name]);

  return (
    <AppLanguageContext.Provider value={language}>
    <ProContext.Provider value={{ hasProAccess: proEntitlement.hasProAccess, openPro }}>
      <SafeAreaProvider initialMetrics={initialWindowMetrics} style={styles.app}>
        <StatusBar barStyle="dark-content" />
        <SafeAreaView key={ledgerEpoch} edges={activeTab ? ["top", "left", "right"] : ["top", "bottom", "left", "right"]}
          accessibilityElementsHidden={proOpen} importantForAccessibility={proOpen ? "no-hide-descendants" : "auto"} style={styles.main}>
          {!preferences || !ledgerReady ? (
            <View style={styles.loading}><ActivityIndicator color={colors.ink} accessibilityLabel={settingsCopy(language).working} /></View>
          ) : route.name === "home" ? (
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
                  defaultCurrency={preferences.defaultCurrency}
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
                  defaultCurrency={preferences.defaultCurrency}
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
            <SettingsScreen preferences={preferences} systemLanguage={settings.systemLanguage} saving={settings.saving}
              preferenceError={settings.error} onSave={settings.save} onBack={() => setRoute({ name: "home" })}
              restored={route.restored} recoveryRequired={route.recoveryRequired} onRestored={onRestored}
              onReturnToSettings={() => setRoute({ name: "settings" })} />
          ) : null}
        </SafeAreaView>
        {activeTab && <TabBar active={activeTab} language={language} obscured={proOpen} onSelect={(tab) => setRoute({ name: tab })} />}
        {creationBlocker && <ActivityQuotaSheet blocker={creationBlocker}
          onClose={() => setCreationBlocker(null)} onView={() => openExistingActivity(creationBlocker)} />}
        {proOpen && <SafeAreaView style={styles.proOverlay} accessibilityViewIsModal>
          <ProPaywall onClose={closePro} />
        </SafeAreaView>}
      </SafeAreaProvider>
    </ProContext.Provider>
    </AppLanguageContext.Provider>
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
  pressed: { opacity: 0.65 },
  loading: { flex: 1, alignItems: "center", justifyContent: "center" },
  proOverlay: { ...StyleSheet.absoluteFill, backgroundColor: colors.page },
});

registerRootComponent(App);
