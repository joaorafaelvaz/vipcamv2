"use client";

import { Badge } from "@/components/ui/badge";
import { useDashboardSummary } from "@/lib/queries/dashboard";
import { cn } from "@/lib/utils";
import { Activity, AlertCircle, BarChart3, UserCheck, Users } from "lucide-react";
import type { Route } from "next";
import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/live" as Route, label: "Live", icon: Activity },
  { href: "/people" as Route, label: "Pessoas", icon: Users },
  { href: "/identify" as Route, label: "Identificar", icon: UserCheck },
  { href: "/matches" as Route, label: "Matches", icon: AlertCircle },
  { href: "/metrics" as Route, label: "Métricas", icon: BarChart3 },
] as const;

export function Topbar() {
  const pathname = usePathname();
  const { data } = useDashboardSummary();
  const pendingMatches = data?.pending_matches ?? 0;

  return (
    <header className="h-12 border-b bg-slate-900 text-white flex items-center px-4 gap-6">
      <div className="font-bold text-yellow-400">VipCam</div>
      <nav className="flex gap-1">
        {TABS.map((tab) => {
          const active = pathname?.startsWith(tab.href);
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-label={tab.label}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 text-sm rounded transition-colors",
                active ? "bg-slate-700" : "hover:bg-slate-800 text-slate-200",
              )}
            >
              <tab.icon className="w-4 h-4" />
              {tab.label}
              {tab.label === "Matches" && pendingMatches > 0 && (
                <Badge variant="destructive" className="ml-1 h-5 px-1.5">
                  {pendingMatches}
                </Badge>
              )}
            </Link>
          );
        })}
      </nav>
      <div className="ml-auto text-xs text-slate-400">
        {data?.last_detection_at
          ? `última detecção: ${new Date(data.last_detection_at).toLocaleTimeString("pt-BR")}`
          : "sem detecções"}
      </div>
    </header>
  );
}
