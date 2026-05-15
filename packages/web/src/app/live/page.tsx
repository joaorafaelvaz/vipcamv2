import { LiveFeed } from "@/components/live-feed";

// Dashboard client-rendered com env de runtime + SSE ao vivo — não faz
// sentido prerender estático (e quebra: getClientEnv() roda no build).
export const dynamic = "force-dynamic";

export default function LivePage() {
  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Live feed</h1>
      <LiveFeed />
    </div>
  );
}
