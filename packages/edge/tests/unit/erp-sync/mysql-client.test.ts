import { describe, expect, test } from "bun:test";
import { buildErpPoolConfig } from "../../../src/erp-sync/mysql-client.js";

describe("buildErpPoolConfig", () => {
  test("inclui timezone do env (BRT->UTC correto) + uri", () => {
    const cfg = buildErpPoolConfig({
      ERP_MYSQL_URL: "mysql://u:p@h:3306/db",
      ERP_TZ_OFFSET: "-03:00",
    });
    expect(cfg.uri).toBe("mysql://u:p@h:3306/db");
    expect(cfg.timezone).toBe("-03:00");
    // pool defensivo: limites preservados
    expect(cfg.connectionLimit).toBe(5);
    expect(cfg.waitForConnections).toBe(true);
    expect(cfg.queueLimit).toBe(0);
  });

  test("propaga offset custom (ex: outro fuso)", () => {
    const cfg = buildErpPoolConfig({
      ERP_MYSQL_URL: "mysql://x",
      ERP_TZ_OFFSET: "+00:00",
    });
    expect(cfg.timezone).toBe("+00:00");
  });
});
