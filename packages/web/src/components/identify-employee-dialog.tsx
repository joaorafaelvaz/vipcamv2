"use client";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useIdentifyAsEmployee } from "@/lib/queries/identify";
import { usePeople } from "@/lib/queries/persons";
import { cn } from "@/lib/utils";
import { UserCheck } from "lucide-react";
import { useState } from "react";

/**
 * Onda 10 — "esse anônimo é o funcionário X".
 * Dialog com filtro client-side sobre a lista de funcionários (~148, 1 fetch).
 * Reusado na fila /identify e no perfil de anônimo (/people/[id]).
 * `defaultOpen` existe p/ testabilidade (radix portal em happy-dom).
 */
export function IdentifyEmployeeDialog({
  anonId,
  defaultOpen = false,
}: {
  anonId: string;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const { data, isLoading } = usePeople({ type: "employee", limit: 200 });
  const identify = useIdentifyAsEmployee();

  const employees = (data?.items ?? []).filter((e) =>
    filter ? (e.display_name ?? "").toLowerCase().includes(filter.toLowerCase()) : true,
  );

  function confirm() {
    if (!selected) return;
    identify.mutate({ anonId, employeePersonId: selected }, { onSuccess: () => setOpen(false) });
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <UserCheck className="w-4 h-4 mr-1.5" />É funcionário…
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Qual funcionário é essa pessoa?</DialogTitle>
        </DialogHeader>
        <Input
          placeholder="Buscar funcionário…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          autoFocus
        />
        <div className="max-h-64 overflow-y-auto space-y-1">
          {isLoading ? (
            <div className="text-sm text-slate-500 py-2">Carregando…</div>
          ) : employees.length === 0 ? (
            <div className="text-sm text-slate-500 py-2">Nenhum funcionário encontrado</div>
          ) : (
            employees.map((e) => (
              <button
                key={e.id}
                type="button"
                onClick={() => setSelected(e.id)}
                className={cn(
                  "w-full text-left px-3 py-2 rounded text-sm transition-colors",
                  selected === e.id ? "bg-slate-900 text-white" : "hover:bg-slate-100",
                )}
              >
                {e.display_name ?? "(sem nome)"}
              </button>
            ))
          )}
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancelar
          </Button>
          <Button disabled={!selected || identify.isPending} onClick={confirm}>
            Confirmar
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
