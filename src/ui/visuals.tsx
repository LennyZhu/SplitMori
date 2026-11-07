import Svg, { Circle, G, Path, Rect } from "react-native-svg";

const ink = "#282828";
const white = "#FFFFFF";

export const colors = {
  page: "#FDFCFB",
  surface: white,
  quiet: "#F7F7F7",
  tile: "#F0F0EF",
  line: "#E7E5E2",
  ink,
  primary: ink,
  onPrimary: white,
  muted: "#575757",
  accent: "#A58A75",
  accentText: "#705947",
  shadow: "rgba(40, 40, 40, 0.07)",
} as const;

const paths = {
  globe: "M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0Zm0 0h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z",
  coins: "M3 7c0-4 11-4 11 0s-11 4-11 0Zm0 0v9c0 4 11 4 11 0V7m0 4h6v7c0 3-4 4-8 3",
  database: "M4 5.5c0-4 16-4 16 0s-16 4-16 0Zm0 0v13c0 4 16 4 16 0v-13M4 12c0 4 16 4 16 0",
  crown: "m3 7 5 5 4-7 4 7 5-5-2 13H5L3 7Z",
  refresh: "M4 9a8 8 0 0 1 14-3l2 3m0-5v5h-5m5 6a8 8 0 0 1-14 3l-2-3m0 5v-5h5",
  shield: "m12 3 8 3v6c0 4-4 7-8 9-4-2-8-5-8-9V6l8-3Zm-3 9 2 2 4-4",
  help: "M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0Zm6-3a3 3 0 0 1 6 0c0 2-3 2-3 4m0 3h.01",
  info: "M3 12a9 9 0 1 0 18 0 9 9 0 1 0-18 0Zm9-1v5m0-8h.01",
  export: "M4 14v6h16v-6m-8 2V3m-5 5 5-5 5 5",
  download: "M4 14v6h16v-6m-8 1V3m-5 7 5 5 5-5",
  file: "M6 3h8l4 4v14H6V3Zm7 0v5h5m-9 4h6m-6 4h6",
  folder: "M3 6h7l2 3h9v11H3V6Z",
  warning: "m12 3 10 18H2L12 3Zm0 7v4m0 3h.01",
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
  equalSplit: "M11 3a9 9 0 1 0 10 10H11ZM14 3v7h7a9 9 0 0 0-7-7Z",
  treatSplit: "M3 10h18v10H3ZM2 7h20v3H2Zm10 0v13m0-13C6 7 6 2 9 3c1.5.5 2.5 2.5 3 4Zm0 0c6 0 6-5 3-4-1.5.5-2.5 2.5-3 4Z",
  individualSplit: "M3 5h3m3 0h12M3 12h3m3 0h12M3 19h3m3 0h12",
  customSplit: "M4 6h16M4 12h16M4 18h16M8 3v6m8 0v6m-6 0v6",
  minus: "M5 12h14",
  down: "m6 9 6 6 6-6",
  check: "m5 12 4 4L19 6",
  member: "M8 8a4 4 0 1 0 8 0 4 4 0 0 0-8 0Zm-4 12v-1a5 5 0 0 1 5-5h6a5 5 0 0 1 5 5v1Z",
  more: "M5 12h.1m6.9 0h.1m6.9 0h.1",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, color = colors.ink, size = 24, filled = false }: {
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
      <Rect x={22} y={22} width={64} height={45} rx={11} fill={colors.line} transform="rotate(7 54 45)" />
      <G transform="rotate(-9 40 39)">
        <Rect x={8} y={11} width={67} height={54} rx={11} fill={colors.tile} />
        <G fill="none" stroke={colors.muted} strokeWidth={2.2} strokeLinecap="round">
          <Circle cx={25} cy={31} r={2.3} />
          <Circle cx={25} cy={47} r={2.3} />
          <Path d="M34 31h23M34 47h23" />
        </G>
      </G>
      <Path d="m84 11 2-7m4 12 5-4m-2 11 7-1" stroke={colors.accent} strokeWidth={2.4} strokeLinecap="round" />
    </Svg>
  );
}
