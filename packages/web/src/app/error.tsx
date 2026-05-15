"use client";

import { useEffect } from "react";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  // M1 (review 2026-05-15): NÃO renderizar error.message no kiosk público
  // (pode vazar detalhe interno/stack). Loga no console p/ debug; o digest
  // do Next correlaciona com o log do servidor.
  useEffect(() => {
    console.error("UI error boundary:", error);
  }, [error]);

  return (
    <div className="container mx-auto p-12 text-center">
      <h2 className="text-xl font-semibold mb-2">Algo deu errado</h2>
      <p className="text-slate-600 mb-4">
        Ocorreu um erro inesperado. Tente de novo.
        {error.digest && (
          <span className="block text-xs text-slate-400 mt-1">ref: {error.digest}</span>
        )}
      </p>
      <button type="button" onClick={reset} className="px-4 py-2 bg-slate-900 text-white rounded">
        Tentar de novo
      </button>
    </div>
  );
}
