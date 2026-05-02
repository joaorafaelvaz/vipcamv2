import { createHash, randomBytes } from "node:crypto";
import { logger } from "../obs/logger.js";

export interface DigestChallenge {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  // String aberta porque servidores podem retornar MD5, MD5-sess, SHA-256 etc.
  // Implementação atual só suporta MD5 / MD5-sess (Dahua); validamos no buildDigestHeader.
  algorithm?: string;
}

export function parseDigestChallenge(headerValue: string): DigestChallenge | null {
  if (!headerValue || !headerValue.toLowerCase().startsWith("digest ")) return null;
  const params = headerValue.slice(7);
  const out: Record<string, string> = {};
  // Match "key=value" or 'key="value"'
  const re = /(\w+)\s*=\s*(?:"([^"]*)"|([^,\s]+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(params)) !== null) {
    const key = m[1];
    if (!key) continue;
    out[key.toLowerCase()] = m[2] ?? m[3] ?? "";
  }
  if (!out.realm || !out.nonce) return null;
  const challenge: DigestChallenge = {
    realm: out.realm,
    nonce: out.nonce,
    algorithm: out.algorithm ?? "MD5",
  };
  if (out.qop !== undefined) challenge.qop = out.qop;
  if (out.opaque !== undefined) challenge.opaque = out.opaque;
  return challenge;
}

interface BuildArgs {
  challenge: DigestChallenge;
  method: string;
  uri: string;
  username: string;
  password: string;
  cnonce: string;
  nc: number;
}

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export function buildDigestHeader(a: BuildArgs): string {
  const ha1 = md5(`${a.username}:${a.challenge.realm}:${a.password}`);
  const ha2 = md5(`${a.method}:${a.uri}`);
  const ncHex = a.nc.toString(16).padStart(8, "0");
  const qop = a.challenge.qop?.split(",")[0]?.trim() ?? "auth";
  const response = md5(`${ha1}:${a.challenge.nonce}:${ncHex}:${a.cnonce}:${qop}:${ha2}`);

  const parts = [
    `username="${a.username}"`,
    `realm="${a.challenge.realm}"`,
    `nonce="${a.challenge.nonce}"`,
    `uri="${a.uri}"`,
    `algorithm=${a.challenge.algorithm ?? "MD5"}`,
    `response="${response}"`,
    `qop=${qop}`,
    `nc=${ncHex}`,
    `cnonce="${a.cnonce}"`,
  ];
  if (a.challenge.opaque) parts.push(`opaque="${a.challenge.opaque}"`);
  return `Digest ${parts.join(", ")}`;
}

export interface DahuaClientConfig {
  baseUrl: string; // http://192.168.x.x
  username: string;
  password: string;
  timeoutMs?: number; // timeout default para chamadas curtas
}

export interface RequestOptions {
  /** Timeout customizado (ms). Use `null` para desabilitar (long-polling). */
  timeoutMs?: number | null;
  /** AbortSignal externo (precedência sobre timeoutMs). */
  signal?: AbortSignal;
}

export class DahuaHttpClient {
  private cfg: Required<Pick<DahuaClientConfig, "baseUrl" | "username" | "password">> & {
    timeoutMs: number;
  };
  private cachedChallenge: DigestChallenge | null = null;
  private nc = 0;

  constructor(cfg: DahuaClientConfig) {
    this.cfg = {
      baseUrl: cfg.baseUrl,
      username: cfg.username,
      password: cfg.password,
      timeoutMs: cfg.timeoutMs ?? 10_000,
    };
  }

  /**
   * Faz GET com Digest auth. Tenta sem auth primeiro, captura o 401, refaz com Digest.
   * Cacheia o challenge para chamadas subsequentes (Dahua aceita reuso por uns minutos).
   *
   * `opts.timeoutMs = null` desabilita o timeout (necessário para long-polling do
   * eventManager attach que dura minutos).
   */
  async get(path: string, opts: RequestOptions = {}): Promise<Response> {
    const url = `${this.cfg.baseUrl}${path}`;
    const signal = this.resolveSignal(opts);

    if (this.cachedChallenge) {
      const auth = this.makeAuthHeader("GET", path);
      const r = await fetch(url, this.buildInit({ Authorization: auth }, signal));
      if (r.status !== 401) return r;
      // challenge expirou ou stale — refaz fluxo completo e reseta nc
      await r.body?.cancel().catch(() => {});
      this.cachedChallenge = null;
      this.nc = 0;
    }

    // 1ª tentativa: sem auth, esperando 401 com challenge
    const r1 = await fetch(url, this.buildInit(undefined, signal));
    if (r1.status !== 401) return r1;

    const challengeHeader = r1.headers.get("www-authenticate");
    const challenge = parseDigestChallenge(challengeHeader ?? "");
    if (!challenge) {
      logger.warn({ path, header: challengeHeader }, "no Digest challenge in 401");
      return r1;
    }
    // Drena o body do 401 antes de descartá-lo
    await r1.body?.cancel().catch(() => {});
    this.cachedChallenge = challenge;
    this.nc = 0; // novo nonce → reset do contador (RFC 7616 §3.3)

    const auth = this.makeAuthHeader("GET", path);
    return fetch(url, this.buildInit({ Authorization: auth }, signal));
  }

  /**
   * Constrói RequestInit omitindo campos undefined (necessário para
   * exactOptionalPropertyTypes — fetch exige signal: AbortSignal | null, não undefined).
   */
  private buildInit(
    headers: Record<string, string> | undefined,
    signal: AbortSignal | undefined,
  ): RequestInit {
    const init: RequestInit = {};
    if (headers) init.headers = headers;
    if (signal) init.signal = signal;
    return init;
  }

  /**
   * Variante streaming para long-polling (eventManager attach). Por padrão
   * desabilita o timeout, já que essas chamadas duram minutos.
   * Caller é responsável por gerenciar deadline via AbortSignal externo.
   */
  async getStream(path: string, opts: RequestOptions = {}): Promise<Response> {
    return this.get(path, { timeoutMs: null, ...opts });
  }

  private resolveSignal(opts: RequestOptions): AbortSignal | undefined {
    if (opts.signal) return opts.signal;
    const t = opts.timeoutMs === undefined ? this.cfg.timeoutMs : opts.timeoutMs;
    if (t === null || t === undefined) return undefined;
    return AbortSignal.timeout(t);
  }

  private makeAuthHeader(method: string, uri: string): string {
    if (!this.cachedChallenge) throw new Error("no cached challenge");
    this.nc += 1;
    const cnonce = randomBytes(8).toString("hex");
    return buildDigestHeader({
      challenge: this.cachedChallenge,
      method,
      uri,
      username: this.cfg.username,
      password: this.cfg.password,
      cnonce,
      nc: this.nc,
    });
  }
}
