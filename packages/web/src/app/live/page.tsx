import { LiveFeed } from "@/components/live-feed";

export default function LivePage() {
  return (
    <div className="container mx-auto p-6 max-w-3xl">
      <h1 className="text-2xl font-semibold mb-4">Live feed</h1>
      <LiveFeed />
    </div>
  );
}
