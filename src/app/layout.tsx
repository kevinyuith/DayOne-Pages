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
  description: "Painel de gerenciamento do DayOne Pages",
  robots: { index: false, follow: false },
  // O Chrome também lê esta meta; o translate="no" abaixo cobre os outros navegadores.
  other: { google: "notranslate" },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // translate="no": o painel tem textos em inglês de propósito; sem isto o navegador
    // em português traduz a tela sozinho (e traduz até nomes de domínio e caminhos).
    <html
      lang="pt-BR"
      translate="no"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      {/* Extensões (ColorZilla etc.) injetam atributos no <body> antes da hidratação. Só vale para os atributos do body, não para os filhos. */}
      <body className="min-h-full flex flex-col" suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
