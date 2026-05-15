"use client";

export default function ErrorBoundary({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="container mx-auto p-12 text-center">
      <h2 className="text-xl font-semibold mb-2">Algo deu errado</h2>
      <p className="text-slate-600 mb-4">{error.message}</p>
      <button type="button" onClick={reset} className="px-4 py-2 bg-slate-900 text-white rounded">
        Tentar de novo
      </button>
    </div>
  );
}
