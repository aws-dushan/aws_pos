import type { Metadata, Viewport } from "next";
import { DM_Sans, Geist_Mono, Sora } from "next/font/google";
import { ThemeProvider } from "next-themes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { MotionProvider } from "@/components/motion";
import { ConfirmHost } from "@/components/confirm";
import { BRAND } from "@/components/logo";
import "./globals.css";

// The AWS One type system: Sora for headings and big numbers, DM Sans for body text, Geist Mono for codes.
const sora = Sora({ variable: "--font-sora", subsets: ["latin"], weight: ["300", "400", "500", "600", "700"] });
const dmSans = DM_Sans({ variable: "--font-dmsans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: BRAND, template: `%s · ${BRAND}` },
  description: `${BRAND}: restaurant point of sale`,
  applicationName: BRAND,
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, viewportFit: "cover" };

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning className={`${sora.variable} ${dmSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full bg-background text-foreground">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <MotionProvider>
            <TooltipProvider>{children}</TooltipProvider>
            <ConfirmHost />
          </MotionProvider>
          <Toaster richColors position="bottom-right" />
        </ThemeProvider>
      </body>
    </html>
  );
}
