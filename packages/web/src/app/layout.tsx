import { Topbar } from "@/components/topbar";
import type { Metadata } from "next";
import { Providers } from "./providers";
import "./globals.css";

export const metadata: Metadata = {
  title: "VIPCam",
  description: "Monitoramento Barbearia VIP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR">
      <body>
        <Providers>
          <div className="min-h-screen flex flex-col">
            <Topbar />
            <main className="flex-1 bg-slate-50">{children}</main>
          </div>
        </Providers>
      </body>
    </html>
  );
}
