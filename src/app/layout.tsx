import type { Metadata } from "next";
import { Barriecito, Schibsted_Grotesk } from "next/font/google";
import "./globals.css";

/* Interface: a sturdy, slightly condensed grotesque that sits quietly next
   to the hand-drawn logo. Barriecito (the logo's lettering) is reserved for
   the wordmark. Both are bundled at build time, so the app works offline. */
const ui = Schibsted_Grotesk({ subsets: ["latin", "latin-ext"], variable: "--font-ui", display: "swap" });
const scribble = Barriecito({ weight: "400", subsets: ["latin"], variable: "--font-scribble", display: "swap" });

export const metadata: Metadata = { title: "mlch", icons: { icon: "/brand/icon.svg" } };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning className={`${ui.variable} ${scribble.variable}`}>
      <body>{children}</body>
    </html>
  );
}
