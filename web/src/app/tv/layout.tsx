import type { Metadata, Viewport } from "next";

// The TV page's own name and web-app manifest, so a TV browser's "Add to launcher" / "Add to Home" makes a One POS Menu icon that
// opens full screen. The manifest is a plain file in public/ (tv.webmanifest), so its address needs the installation's prefix.
const base = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export const metadata: Metadata = {
  title: "One POS Menu",
  manifest: `${base}/tv.webmanifest`,
  icons: { icon: `${base}/tv-icon.svg` },
};

export const viewport: Viewport = { themeColor: "#000000" };

export default function TvLayout({ children }: { children: React.ReactNode }) {
  return children;
}
