import { currencyLabels, searchCurrencies, type AppLanguage } from "../services/appPreferences.ts";
import { useCopy } from "./useCopy.ts";
import { useState } from "react";
import {
  Keyboard, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { Currency } from "../domain/money.ts";
import { colors, Icon } from "./visuals.tsx";

export function currencyName(code: Currency, language: AppLanguage): string {
  return currencyLabels[code][language];
}

export function CurrencyPicker({ selected, onSelect, onClose }: {
  selected: Currency; onSelect: (currency: Currency) => void; onClose: () => void;
}) {
  const t = useCopy();
  const [query, setQuery] = useState("");
  const { top, bottom, left, right } = useSafeAreaInsets();
  const options = searchCurrencies(query);

  function cancel() {
    Keyboard.dismiss();
    onClose();
  }

  return (
    <Modal visible transparent presentationStyle="overFullScreen" animationType="fade" onRequestClose={cancel}>
      <KeyboardAvoidingView
        style={[styles.overlay, { paddingTop: top + 12, paddingLeft: left, paddingRight: right }]}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <Pressable style={StyleSheet.absoluteFill} onPress={cancel} accessible={false} />
        <View
          accessibilityViewIsModal
          onAccessibilityEscape={cancel}
          style={[styles.sheet, { paddingBottom: Math.max(12, bottom) }]}
        >
          <View style={styles.header}>
            <Text accessibilityRole="header" style={styles.title}>{t("選擇幣種")}</Text>
            <Pressable accessibilityRole="button" onPress={cancel} style={styles.cancel}>
              <Text style={styles.cancelText}>{t("取消")}</Text>
            </Pressable>
          </View>
          <TextInput
            accessibilityLabel={t("搜尋幣種")}
            value={query}
            onChangeText={setQuery}
            placeholder={t("搜尋幣種代碼或名稱")}
            placeholderTextColor={colors.muted}
            autoCapitalize="none"
            autoCorrect={false}
            disableFullscreenUI
            returnKeyType="search"
            style={styles.search}
          />
          <ScrollView
            style={styles.list}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
          >
            <View accessibilityRole="radiogroup">
              {options.map((code) => {
                const name = currencyName(code, t.language);
                const checked = code === selected;
                return (
                  <Pressable
                    key={code}
                    accessibilityRole="radio"
                    accessibilityState={{ checked }}
                    accessibilityLabel={`${code} ${name}`}
                    onPress={() => {
                      Keyboard.dismiss();
                      onSelect(code);
                    }}
                    style={({ pressed }) => [styles.option, (checked || pressed) && styles.activeOption]}
                  >
                    <Text style={styles.code}>{code}</Text>
                    <Text style={styles.name}>{name}</Text>
                    {checked && <Icon name="check" color={colors.accentText} size={22} />}
                  </Pressable>
                );
              })}
              {options.length === 0 && (
                <Text accessibilityLiveRegion="polite" style={styles.empty}>{t("找不到符合的幣種。")}</Text>
              )}
            </View>
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  overlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(40, 40, 40, 0.35)" },
  sheet: {
    width: "100%", maxWidth: 620, maxHeight: "100%", flexShrink: 1, alignSelf: "center", gap: 8,
    backgroundColor: colors.surface, borderTopLeftRadius: 22, borderTopRightRadius: 22,
    borderWidth: 1, borderBottomWidth: 0, borderColor: colors.line, paddingHorizontal: 18, paddingTop: 8,
  },
  header: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  title: { color: colors.ink, fontSize: 19, fontWeight: "700", flexShrink: 1 },
  cancel: { minWidth: 44, minHeight: 44, alignItems: "flex-end", justifyContent: "center" },
  cancelText: { color: colors.accentText, fontSize: 15, fontWeight: "600" },
  search: {
    minHeight: 46, color: colors.ink, backgroundColor: colors.page, borderRadius: 10,
    borderWidth: 1, borderColor: colors.line, paddingHorizontal: 12, paddingVertical: 8, fontSize: 16,
  },
  list: { flexGrow: 0, flexShrink: 1 },
  option: {
    minHeight: 52, flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 10,
    paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.line,
  },
  activeOption: { backgroundColor: colors.quiet },
  code: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  name: { color: colors.ink, fontSize: 16, flex: 1 },
  empty: { color: colors.muted, fontSize: 15, paddingVertical: 22, textAlign: "center" },
});
