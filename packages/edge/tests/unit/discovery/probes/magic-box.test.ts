import { describe, expect, test } from "bun:test";
import { parseMagicBoxKeyValue } from "../../../../src/discovery/probes/magic-box.js";

describe("parseMagicBoxKeyValue", () => {
  test("extrai pares chave=valor do formato Dahua", () => {
    const body = `deviceType=IPC-HFW5442T-ASE
serialNumber=ABC123
hardwareVersion=1.00
machineName=IPC`;
    const parsed = parseMagicBoxKeyValue(body);
    expect(parsed.deviceType).toBe("IPC-HFW5442T-ASE");
    expect(parsed.serialNumber).toBe("ABC123");
  });

  test("ignora linhas vazias e malformadas", () => {
    const body = "key1=value1\n\ngarbage\nkey2=value2";
    const parsed = parseMagicBoxKeyValue(body);
    expect(parsed.key1).toBe("value1");
    expect(parsed.key2).toBe("value2");
    expect(Object.keys(parsed)).toHaveLength(2);
  });
});
