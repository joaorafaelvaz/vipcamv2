"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDistanceToNow } from "@/lib/dates";
import { type UsePeopleParams, usePeople } from "@/lib/queries/persons";
import type { Route } from "next";
import Link from "next/link";
import { useState } from "react";

const LIMIT = 50;

export function PersonTable() {
  const [search, setSearch] = useState("");
  const [type, setType] = useState<"all" | "client" | "employee">("all");
  const [page, setPage] = useState(0);

  const params: UsePeopleParams = { limit: LIMIT, offset: page * LIMIT };
  if (type !== "all") params.type = type;
  if (search) params.search = search;
  const { data, isLoading, isFetching } = usePeople(params);

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const maxPage = Math.max(0, Math.ceil(total / LIMIT) - 1);

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-center">
        <Input
          placeholder="🔍 Buscar nome ou telefone…"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(0);
          }}
          className="max-w-md"
        />
        <Select
          value={type}
          onValueChange={(v) => {
            setType(v as "all" | "client" | "employee");
            setPage(0);
          }}
        >
          <SelectTrigger className="w-40">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos</SelectItem>
            <SelectItem value="client">Clientes</SelectItem>
            <SelectItem value="employee">Funcionários</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-sm text-slate-500 ml-auto">
          {isFetching ? "atualizando…" : `${total} pessoa${total === 1 ? "" : "s"}`}
        </span>
      </div>

      <div className="border rounded-md bg-white">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pessoa</TableHead>
              <TableHead className="w-32">Tipo</TableHead>
              <TableHead className="w-40">Última visita</TableHead>
              <TableHead className="w-24 text-right">Visitas</TableHead>
              <TableHead className="w-40">Telefone</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isLoading ? (
              Array.from({ length: 5 }).map((_, i) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: skeleton placeholder
                <TableRow key={i}>
                  <TableCell colSpan={5}>
                    <Skeleton className="h-6" />
                  </TableCell>
                </TableRow>
              ))
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="text-center text-slate-500 py-8">
                  Nenhuma pessoa encontrada
                </TableCell>
              </TableRow>
            ) : (
              items.map((p) => (
                <TableRow key={p.id} className="hover:bg-slate-50">
                  <TableCell>
                    <Link href={`/people/${p.id}` as Route} className="flex items-center gap-2">
                      <Avatar className="w-8 h-8">
                        <AvatarFallback>{(p.display_name ?? "?").slice(0, 2)}</AvatarFallback>
                      </Avatar>
                      <span className="font-medium">{p.display_name ?? "Anônimo"}</span>
                    </Link>
                  </TableCell>
                  <TableCell>
                    <Badge variant={p.person_type === "client" ? "default" : "secondary"}>
                      {p.person_type === "client"
                        ? "Cliente"
                        : p.person_type === "employee"
                          ? "Funcionário"
                          : "Anônimo"}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-slate-600">
                    {p.last_seen_at ? formatDistanceToNow(p.last_seen_at) : "—"}
                  </TableCell>
                  <TableCell className="text-right font-mono">{p.total_visits}</TableCell>
                  <TableCell className="text-slate-600">{p.phone ?? "—"}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {total > LIMIT && (
        <div className="flex justify-end items-center gap-2 text-sm">
          <span className="text-slate-500">
            Página {page + 1} de {maxPage + 1}
          </span>
          <Button
            variant="outline"
            size="sm"
            aria-label="Página anterior"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            ‹
          </Button>
          <Button
            variant="outline"
            size="sm"
            aria-label="Próxima página"
            disabled={page >= maxPage}
            onClick={() => setPage(page + 1)}
          >
            ›
          </Button>
        </div>
      )}
    </div>
  );
}
