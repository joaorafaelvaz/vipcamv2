"use client";

import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { VisitCard } from "@/components/visit-card";
import { usePerson, usePersonSessions } from "@/lib/queries/persons";

// Client-rendered + env runtime — sem prerender estático (ver /live).
export const dynamic = "force-dynamic";

// Next 14 + React 18: params é objeto direto (não Promise).
export default function PersonProfilePage({ params }: { params: { id: string } }) {
  const { id } = params;
  const { data: person, isLoading: loadingPerson, error } = usePerson(id);
  const { data: sessions, isLoading: loadingSessions } = usePersonSessions(id, 30);

  if (loadingPerson) {
    return (
      <div className="container mx-auto p-6">
        <Skeleton className="h-32" />
      </div>
    );
  }
  if (error || !person) {
    return <div className="container mx-auto p-6 text-red-600">Pessoa não encontrada</div>;
  }

  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="flex gap-4 mb-6 pb-4 border-b">
        <Avatar className="w-20 h-20">
          <AvatarFallback className="text-xl">
            {(person.display_name ?? "?").slice(0, 2)}
          </AvatarFallback>
        </Avatar>
        <div className="flex-1">
          <h1 className="text-2xl font-semibold">{person.display_name ?? "Anônimo"}</h1>
          <div className="text-sm text-slate-600">
            {person.person_type === "client"
              ? "Cliente"
              : person.person_type === "employee"
                ? "Funcionário"
                : "Anônimo"}
            {" · "}
            {person.total_visits} visita{person.total_visits === 1 ? "" : "s"}
            {person.first_seen_at &&
              ` · primeira em ${new Date(person.first_seen_at).toLocaleDateString("pt-BR")}`}
          </div>
          {person.phone && <div className="text-sm text-slate-500">📞 {person.phone}</div>}
          <div className="flex gap-2 mt-2">
            {person.avg_dominant_emotion && (
              <Badge variant="outline">😊 Geralmente {person.avg_dominant_emotion}</Badge>
            )}
            {person.avg_visit_duration_min !== null && (
              <Badge variant="outline">
                ~{Math.round(person.avg_visit_duration_min)} min/visita
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div>
        <h2 className="text-lg font-semibold mb-3 text-slate-700">Histórico de visitas</h2>
        {loadingSessions ? (
          <Skeleton className="h-40" />
        ) : !sessions || sessions.length === 0 ? (
          <div className="text-slate-500 italic">Nenhuma visita registrada ainda.</div>
        ) : (
          sessions.map((s) => <VisitCard key={s.id} session={s} />)
        )}
      </div>
    </div>
  );
}
