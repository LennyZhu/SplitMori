import Svg, { Circle, G, Path, Rect } from "react-native-svg";

export const colors = {
  page: "#F9F5F1",
  surface: "#FFF8F2",
  quiet: "#F7EFE7",
  tile: "#F1E5D9",
  line: "#E8DED6",
  outline: "#DECEC0",
  ink: "#171411",
  charcoal: "#2B2622",
  muted: "#615953",
  accent: "#A8734B",
  accentText: "#79492B",
  white: "#FFFFFF",
} as const;

const paths = {
  plus: "M12 5v14M5 12h14",
  settings: "M10 3h4l.5 2.5 1.8.8 2.1-1.4 2.8 2.8-1.4 2.1.8 1.8 2.4.4v4l-2.4.5-.8 1.8 1.4 2.1-2.8 2.8-2.1-1.4-1.8.8L14 25h-4l-.5-2.4-1.8-.8-2.1 1.4-2.8-2.8 1.4-2.1-.8-1.8L1 16v-4l2.4-.4.8-1.8-1.4-2.1 2.8-2.8 2.1 1.4 1.8-.8L10 3Z",
  next: "m9 6 6 6-6 6",
  back: "m15 6-6 6 6 6",
  home: "M2.5 10.5 12 2.75l9.5 7.75h-2v10h-5v-6h-5v6h-5v-10Z",
  calendar: "M4 8.5h16M8 3v4m8-4v4M8 12h3m-3 4h6",
  records: "M4 6h16M4 11h16M4 16h10",
  receipt: "M5 3h14v18l-3.5-2-3.5 2-3.5-2L5 21V3Zm4 5h6m-6 4h6",
  activity: "M4 7h16a1.5 1.5 0 0 1 1.5 1.5v10A1.5 1.5 0 0 1 20 20H4a1.5 1.5 0 0 1-1.5-1.5v-10A1.5 1.5 0 0 1 4 7Zm4 0V4h8v3M7 7v13M17 7v13",
  clock: "M12 7v5l3.5 2",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, color = colors.charcoal, size = 24, filled = false }: {
  name: IconName;
  color?: string;
  size?: number;
  filled?: boolean;
}) {
  return (
    <Svg
      width={size}
      height={size}
      viewBox={name === "settings" ? "0 2 24 24" : "0 0 24 24"}
      accessible={false}
      importantForAccessibility="no"
    >
      <G stroke={color} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" fill="none">
        <Path d={paths[name]} fill={filled && name === "home" ? color : "none"} />
        {name === "settings" && <Circle cx={12} cy={14} r={3.5} />}
        {name === "calendar" && <Rect x={3} y={5} width={18} height={16} rx={2} />}
        {name === "clock" && <Circle cx={12} cy={12} r={9} />}
      </G>
    </Svg>
  );
}

export function EmptyActivityMark() {
  return (
    <Svg width={102} height={76} viewBox="0 0 102 76" accessible={false} importantForAccessibility="no">
      <Rect x={22} y={22} width={64} height={45} rx={11} fill="#E8D8C8" transform="rotate(7 54 45)" />
      <G transform="rotate(-9 40 39)">
        <Rect x={8} y={11} width={67} height={54} rx={11} fill="#F0E3D6" />
        <G fill="none" stroke={colors.accentText} strokeWidth={2.2} strokeLinecap="round">
          <Circle cx={25} cy={31} r={2.3} />
          <Circle cx={25} cy={47} r={2.3} />
          <Path d="M34 31h23M34 47h23" />
        </G>
      </G>
      <Path d="m84 11 2-7m4 12 5-4m-2 11 7-1" stroke={colors.accent} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  );
}
