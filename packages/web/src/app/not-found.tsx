import Link from "next/link";

export default function NotFound() {
  return (
    <div className="container mx-auto p-12 text-center">
      <h2 className="text-xl font-semibold mb-2">Página não encontrada</h2>
      <Link href="/live" className="text-blue-600">
        ← Voltar pro Live
      </Link>
    </div>
  );
}
