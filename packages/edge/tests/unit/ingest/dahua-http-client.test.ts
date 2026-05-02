import { describe, expect, test } from "bun:test";
import { buildDigestHeader, parseDigestChallenge } from "../../../src/ingest/dahua-http-client.js";

describe("parseDigestChallenge", () => {
  test("extrai realm, nonce, qop de um header Digest válido", () => {
    const header =
      'Digest realm="LoginToDevice", qop="auth", nonce="abc123", opaque="xyz", algorithm=MD5';
    const c = parseDigestChallenge(header);
    expect(c).not.toBeNull();
    expect(c?.realm).toBe("LoginToDevice");
    expect(c?.nonce).toBe("abc123");
    expect(c?.qop).toBe("auth");
    expect(c?.opaque).toBe("xyz");
    expect(c?.algorithm).toBe("MD5");
  });

  test("retorna null quando o header não é Digest", () => {
    expect(parseDigestChallenge("Basic realm=foo")).toBeNull();
    expect(parseDigestChallenge("")).toBeNull();
  });
});

describe("buildDigestHeader", () => {
  test("produz header Authorization válido a partir do challenge", () => {
    const challenge = {
      realm: "LoginToDevice",
      nonce: "abc123",
      qop: "auth",
      opaque: "xyz",
      algorithm: "MD5" as const,
    };
    const header = buildDigestHeader({
      challenge,
      method: "GET",
      uri: "/cgi-bin/magicBox.cgi?action=getSystemInfo",
      username: "admin",
      password: "pass",
      cnonce: "0a4f113b",
      nc: 1,
    });
    expect(header).toContain('username="admin"');
    expect(header).toContain('realm="LoginToDevice"');
    expect(header).toContain('nonce="abc123"');
    expect(header).toContain("nc=00000001");
    expect(header).toContain('cnonce="0a4f113b"');
    expect(header).toContain("qop=auth");
    // response é um hash MD5 deterministico
    expect(header).toMatch(/response="[a-f0-9]{32}"/);
  });

  test("calcula response com vetor conhecido (RFC 7616 §3.9.1 adaptado)", () => {
    // Vetor: HA1 = md5("Mufasa:testrealm@host.com:Circle Of Life") = "939e7578ed9e3c518a452acee763bce9"
    // HA2  = md5("GET:/dir/index.html") = "39aff3a2bab6126f332b942af96d3366"
    // response = md5(HA1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + HA2)
    //         = md5("939e7578ed9e3c518a452acee763bce9:dcd98b7102dd2f0e8b11d0f600bfb0c093:00000001:0a4f113b:auth:39aff3a2bab6126f332b942af96d3366")
    //         = "6629fae49393a05397450978507c4ef1"
    const header = buildDigestHeader({
      challenge: {
        realm: "testrealm@host.com",
        nonce: "dcd98b7102dd2f0e8b11d0f600bfb0c093",
        qop: "auth",
      },
      method: "GET",
      uri: "/dir/index.html",
      username: "Mufasa",
      password: "Circle Of Life",
      cnonce: "0a4f113b",
      nc: 1,
    });
    expect(header).toContain('response="6629fae49393a05397450978507c4ef1"');
  });
});
