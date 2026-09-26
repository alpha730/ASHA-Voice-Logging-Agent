import type { Metadata, Viewport } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASHA Voice Log",
  description: "Speak a home visit, get a structured health record.",
  manifest: "/manifest.webmanifest",
};

export const viewport: Viewport = { themeColor: "#0f766e", width: "device-width", initialScale: 1 };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link href="/" className="brand">ASHA Voice Log</Link>
          <nav>
            <Link href="/record">Record</Link>
            <Link href="/patients">Patients</Link>
            <Link href="/dashboard">Dashboard</Link>
            <Link href="/before-after">Before / After</Link>
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
