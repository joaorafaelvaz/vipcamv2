import { IdentifyQueue } from "@/components/identify-queue";

// Client-rendered + env runtime — sem prerender estático (ver /live).
export const dynamic = "force-dynamic";

export default function IdentifyPage() {
  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-1">Identificar funcionários</h1>
      <p className="text-sm text-slate-500 mb-4">
        Pessoas vistas com frequência pela câmera, ainda sem identificação. Diga quem é funcionário
        — a câmera passa a reconhecê-lo e ele sai da revisão de matches.
      </p>
      <IdentifyQueue />
    </div>
  );
}
