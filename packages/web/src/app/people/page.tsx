import { PersonTable } from "@/components/person-table";

export default function PeoplePage() {
  return (
    <div className="container mx-auto p-6">
      <h1 className="text-2xl font-semibold mb-4">Pessoas</h1>
      <PersonTable />
    </div>
  );
}
