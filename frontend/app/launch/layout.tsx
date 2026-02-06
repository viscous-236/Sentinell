/**
 * Dashboard Layout with Theme Provider
 * Wraps dashboard pages with theme context and consistent styling
 */
import type { Metadata } from "next";
import { ThemeProvider } from "next-themes";

export const metadata: Metadata = {
  title: "SENTINEL LIVE | Real-Time Protection Dashboard",
  description: "Monitor Sentinel's AI protection layer in real-time",
};

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <ThemeProvider attribute="class" defaultTheme="dark" enableSystem>
      <div className="min-h-screen bg-background text-foreground">
        {children}
      </div>
    </ThemeProvider>
  );
}
