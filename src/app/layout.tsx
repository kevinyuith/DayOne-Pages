import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "DayOne Pages",
    template: "%s | DayOne Pages",
  },
  description: "DayOne Pages management dashboard",
  robots: { index: false, follow: false },
  // Chrome also reads this meta; the translate="no" below covers the other browsers.
  other: { google: "notranslate" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // translate="no": the dashboard text is in English on purpose; without this a browser
    // set to Portuguese translates the screen by itself (even domain names and paths).
    <html
      lang="en"
      translate="no"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Extensions (ColorZilla etc.) inject attributes into <body> before hydration. Only applies to the body's attributes, not its children. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
