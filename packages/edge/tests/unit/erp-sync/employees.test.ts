// Setup env BEFORE importing — getEnv() é cached na 1ª chamada, então
// precisa ter valores válidos antes que syncEmployees importe transitivamente.
// Mock.module no env.js leakaria pra outros tests (bun:test process-wide).
process.env.API_KEY = "test-key-employees";
process.env.DATABASE_URL = "postgres://test:test@127.0.0.1:5432/vipcam_test";
process.env.ERP_PHOTO_URL_PREFIX = "https://test/img/";

import { beforeEach, describe, expect, mock, test } from "bun:test";

let fetchedRows: Array<Record<string, unknown>> = [];
let upsertEmployeeCalls = 0;
let personsCreateCalls: Array<{ erp_employee_id: string; display_name: string }> = [];
let seedCalls: Array<{ erpId: string | undefined; photoUrl: string }> = [];
let seedResult: { status: string; face_record_id?: string; reason?: string } = {
  status: "embedded",
  face_record_id: "fr-1",
};
let seedImpl:
  | ((person: { erp_employee_id: string }, photoUrl: string) => Promise<{ status: string }>)
  | null = null;

const installMocks = () => {
  mock.module("../../../src/erp-sync/queries.js", () => ({
    fetchErpEmployees: async () => fetchedRows,
  }));
  mock.module("../../../src/persistence/repositories/index.js", () => ({
    erpRepo: {
      findEmployeeByErpId: async () => null, // sempre cria new
      upsertEmployee: async () => {
        upsertEmployeeCalls += 1;
      },
    },
    personsRepo: {
      create: async (data: { erp_employee_id: string; display_name: string }) => {
        personsCreateCalls.push(data);
        return { id: `p-${data.erp_employee_id}`, ...data };
      },
      update: async (_id: string, _patch: Record<string, unknown>) => undefined,
      findByErpEmployeeId: async () => null,
    },
  }));
  mock.module("../../../src/erp-sync/employee-face-seeder.js", () => ({
    seedEmployeeFace: async (person: { erp_employee_id: string }, photoUrl: string) => {
      if (seedImpl) return seedImpl(person, photoUrl);
      seedCalls.push({ erpId: person.erp_employee_id, photoUrl });
      return seedResult;
    },
  }));
  mock.module("../../../src/erp-sync/employee-face-seeder-deps.js", () => ({
    makeProductionDeps: () => ({}),
  }));
};
installMocks();

import { syncEmployees } from "../../../src/erp-sync/employees.js";

beforeEach(() => {
  fetchedRows = [];
  upsertEmployeeCalls = 0;
  personsCreateCalls = [];
  seedCalls = [];
  seedResult = { status: "embedded", face_record_id: "fr-1" };
  seedImpl = null;
  installMocks();
});

describe("syncEmployees Onda 9-B integration", () => {
  test("para cada row chama upsertEmployee + Person.create + seedEmployeeFace", async () => {
    fetchedRows = [
      { id: 999, name: "Wagner", is_active: 1, photo_url: "avatar_999.jpg?p8yr" },
      { id: 998, name: "Maria", is_active: 1, photo_url: "padrao_fem.jpg" },
    ];
    const result = await syncEmployees();
    expect(upsertEmployeeCalls).toBe(2);
    expect(personsCreateCalls).toHaveLength(2);
    expect(seedCalls).toEqual([
      { erpId: "999", photoUrl: "avatar_999.jpg?p8yr" },
      { erpId: "998", photoUrl: "padrao_fem.jpg" },
    ]);
    expect(result.fetched).toBe(2);
    expect(result.created).toBe(2);
  });

  test("falha do seeder NÃO interrompe loop pros próximos employees", async () => {
    fetchedRows = [
      { id: 100, name: "A", is_active: 1, photo_url: "avatar_100.jpg?aaaa" },
      { id: 200, name: "B", is_active: 1, photo_url: "avatar_200.jpg?bbbb" },
    ];
    let callIdx = 0;
    seedImpl = async (person, photoUrl) => {
      seedCalls.push({ erpId: person.erp_employee_id, photoUrl });
      callIdx += 1;
      if (callIdx === 1) throw new Error("seeder boom for #1");
      return { status: "embedded" };
    };
    const result = await syncEmployees();
    expect(seedCalls).toHaveLength(2); // ambos chamados, primeiro deu erro
    expect(result.fetched).toBe(2);
    expect(result.seeder_unexpected_error).toBe(1);
    expect(result.embedded).toBe(1);
  });

  test("aggregate result tem counters por SeedResult status", async () => {
    fetchedRows = [
      { id: 1, name: "n", is_active: 1, photo_url: "padrao_masc.jpg" },
      { id: 2, name: "n", is_active: 1, photo_url: "avatar_2.jpg?xxxx" },
    ];
    let i = 0;
    seedImpl = async () => {
      i += 1;
      return i === 1 ? { status: "placeholder" } : { status: "embedded" };
    };
    const result = await syncEmployees();
    expect(result.embedded).toBe(1);
    expect(result.skipped_placeholder).toBe(1);
  });
});
