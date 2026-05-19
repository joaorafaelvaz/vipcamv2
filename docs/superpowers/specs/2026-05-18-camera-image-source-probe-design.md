# Design: Onda 6 — Camera Image-Source Probe (gate do Failover B)

**Data:** 2026-05-18
**Status:** Aprovado (saiu de brainstorming, pendente plano de implementação)
**Autor(es):** Rafael Vaz + Claude
**Contexto:** Ondas 1–5 em produção (ingest, ERP match temporal, frontend, débitos, dashboard de métricas). Failover B (re-id local InsightFace + pgvector) é a feature de maior valor estratégico mas está **hard-gated**: precisa de uma imagem de rosto utilizável por detecção, e a fonte na câmera DH-IPC-HFW5442T-ASE é empiricamente não-verificada. Hoje o ingest **não captura imagem** (`dahua-event-parse.ts` não extrai; `snapshot_path` nunca é preenchido). Esta onda resolve o gate com **evidência**.

---

## 1. Objetivo & entregável

**Não é feature de produto.** Entregável = **evidência + decisão go/no-go**, não re-id em produção.

Pergunta que o probe responde conclusivamente: *por detecção de rosto da DH-IPC-HFW5442T-ASE, conseguimos uma imagem de rosto utilizável (detectável por InsightFace) pra gerar embedding?* — concluindo uma de:

- **(a)** imagem `image/*` embutida no multipart do `eventManager.cgi` por evento de face.
- **(b)** `snapshot.cgi` temporalmente alinhado ao evento, com rosto utilizável.
- **(c)** (a) e (b) reprovam → recomenda onda follow-up de RTSP frame-grab (**não construída aqui**).
- **(d)** (a)+(b) reprovam e a evidência indica que a câmera não entrega rosto utilizável → Failover B inviável neste hardware (reavaliar estratégia).

**Entregáveis concretos:**
1. Relatório JSON estilo-Discovery (integra o framework `runDiscovery`/`report` existente).
2. Doc markdown de decisão `docs/superpowers/specs/<data>-camera-image-source-probe-report.md` — conclusão a/b/c/d, evidência (taxas, tamanhos, timing, latência InsightFace-CPU), thresholds usados, recomendação direta pro spec do Failover B.
3. `packages/reid` bootstrapado com InsightFace real (`buffalo_s`, CPU/onnxruntime) + `POST /detect` — **subproduto reutilizável**: metade da infra do Failover B de pé + de-risca "InsightFace roda aceitável neste VPS CPU?".

**Fora de escopo (YAGNI):** re-id/embeddings em produção, pgvector ANN wiring, captura RTSP, qualquer mudança de comportamento de produto, privacidade/retention/LGPD (segue como débito separado já rastreado — explicitamente fora desta onda por decisão do usuário).

---

## 2. Decisões consolidadas (brainstorming 2026-05-18)

| Dimensão | Decisão |
|---|---|
| Próxima onda | Probe de fonte-de-imagem (resolve gate Failover B), não Failover B nem Retention |
| Profundidade | Capturar amostras reais **+ validar rosto** com detector real (evidência p/ afirmar/descartar 'd') |
| Detector | Bootstrap `packages/reid` com InsightFace real (`buffalo_s`, CPU) + `/detect` — stack exata do Failover B |
| Captura de evento | **Hook de inspeção no ingest existente** — tap byte-level na conexão `eventManager.cgi` já aberta; **sem 2ª conexão** |
| Escopo RTSP (c) | **Adiado** — probar só (a)+(b); (c) vira follow-up se ambos falharem |
| Arquitetura | Extensão Discovery, on-demand, **2 fases** (captura → validação+relatório); captura e validação **desacopladas** |
| LGPD | Fora de escopo desta onda (débito separado) |

---

## 3. Restrição técnica fundamental (ancorada no código)

`parseMultipartChunks` (`packages/edge/src/discovery/capture.ts`) faz `buf.slice(...).toString("utf8")` e descarta os headers da parte. Isso **corromperia `image/jpeg`** (decode utf8 de binário) e perde o `Content-Type`. Logo a opção (a) **não pode** reusar esse caminho string.

Como só pode haver **1 reader** num `ReadableStream` e o ingest já consome o stream via `consumeStream` (`packages/edge/src/ingest/listener-stream.ts`), o tap precisa operar **dentro do loop do `consumeStream`**, sobre os bytes já em memória (`value`/`pending`), **antes** do parse string lossy. Novo parser byte-level header-aware em `discovery/capture.ts`:

```
parseMultipartPartsRaw(buf: Buffer, boundary: string)
  → { parts: Array<{ headers: Record<string,string>, body: Buffer }>, remainder: Buffer }
```

— preserva headers (`Content-Type`) e bytes crus por parte; `remainder` com a mesma semântica de borda do parser atual (não perde parte parcial entre chunks). Usado **apenas em probe-mode**; o caminho de produção (`parseMultipartChunks` → string → `parseDahuaEventLine`) fica **inalterado**.

---

## 4. Arquitetura & componentes

### Fase 1 — Captura (probe-mode ON, janela limitada)

- **Tap no `consumeStream`** (`listener-stream.ts`): nova opção **injetada** `probeTap?: (chunkBuf, boundary) => void` em `ConsumeStreamOptions` (callback param — **não** importar estado de probe pro módulo; `consumeStream` permanece função pura, preservando o teste §7 "tap ausente → comportamento idêntico"). Quando presente, dentro do loop, **após** `pending = Buffer.concat(...)` e **antes/junto** do `parseMultipartChunks`, alimenta um extrator probe com cópia dos bytes. Quando ausente → comportamento atual idêntico. O tap é fire-and-forget e try/catch isolado (exceção logada, ingest continua).
- **Extrator de partes** usa `parseMultipartPartsRaw`. Parte com `Content-Type: image/*` → enfileira amostra `{source:"event", event_idx, event_code, event_ts, captured_ts, content_type, byte_len, body}`; persiste em disco assíncrono (fila limitada; sob backpressure **descarta**).
- **Sampler `snapshot.cgi`**: a cada evento cujo `code` é de face detection, dispara GET `/cgi-bin/snapshot.cgi?channel=1` via `DahuaHttpClient` existente; salva imagem + `{source:"snapshot", event_ts, captured_ts, delta_ms, content_type, http_status, byte_len}`. Independente do stream (GET separado, seguro). **O(s) `code` de face detection deste modelo são empiricamente não-verificados** (parte do que o probe estabelece) → o filtro de code é **configurável e erra para over-sampling** (default: dispara em qualquer evento plausível de face/`Object`), pra um palpite errado de code não zerar silenciosamente a evidência da via (b).
- **Store:** `/var/lib/vipcam/probe-samples/` (já writable — `/var/lib/vipcam` nos `ReadWritePaths` dos units desde Onda 4 D3). Layout: `samples-<runId>/<seq>.<ext>` + `<seq>.json` sidecar + `manifest.json` da run.
- **Controle:** ação no `/api/discovery/*` (já protegido por `requireKey`) — `start` (params: `window_minutes` ≤60, `max_samples`, thresholds opcionais), `stop`, `status`. **Cap duro de janela ≤60min** com auto-expire mesmo sem `stop`. Recusa `start` se disco livre < limite. Start/stop idempotente.

### Fase 2 — Validação & relatório (desacoplada; re-rodável sem recapturar)

- **`packages/reid` com InsightFace real:** substitui o stub. `buffalo_s` em CPU via onnxruntime. `POST /detect` (body: imagem; resp: `{ faces: [{ bbox:[x,y,w,h], det_score:number }], width, height, infer_ms }` — `bbox` em **pixels da imagem nativa** recebida; `width/height` são as dims dessa imagem, pra threshold de px ser inequívoco entre fontes event vs snapshot de resoluções diferentes). `/health` mantido. **Cache do modelo:** InsightFace baixa `buffalo_s` em `~/.insightface/models` por padrão — bloqueado pelo `ProtectHome=read-only`/`ProtectSystem=strict` do unit. O plano DEVE setar `INSIGHTFACE_HOME` (ou equivalente) pra um path dentro dos `ReadWritePaths` do `vipcam-reid.service` e documentar o provisionamento do modelo no VPS. systemd unit `vipcam-reid` (há `.example`) instalado pra esta onda, com `ReadWritePaths` cobrindo o cache do modelo.
- **Runner de validação** (TS no edge, padrão `discovery/runner.ts`+`report.ts`): lê `samples-<runId>/`, `POST /detect` por amostra (timeout por imagem; conta falhas; reid down → relatório "validação indisponível, amostras OK, re-rodar"), agrega **por fonte** (event vs snapshot): nº amostras, taxa de imagem presente, taxa de rosto utilizável, bbox mediano px, dims medianas, distribuição de `infer_ms`, Δ-timing evento↔snapshot mediano.
- **Decisão** aplica os critérios da §5 → emite (1) JSON report (schema do framework Discovery, novo `ProbeResult`/seção) e (2) doc markdown de decisão com conclusão + evidência + thresholds + recomendação Failover B + (se aplicável) passo de limpeza das amostras.

### Segurança/concorrência

Tap = observação read-only in-process na conexão já aberta (1 reader, bytes teados antes do parse lossy). `snapshot.cgi`/`/detect` = chamadas independentes. reid = processo separado. **Nenhuma 2ª assinatura de evento.** Ingest 100% inalterado com probe-mode OFF.

---

## 5. Critérios de decisão (thresholds parametrizáveis)

Defaults registrados no relatório junto com os dados crus; parametrizáveis no `start`. O probe **não decide sozinho em caso ambíguo** — num borderline marca "revisão humana" com a evidência.

| Conclusão | Critério (default) |
|---|---|
| **(a) viável** | ≥ **70%** dos eventos de face capturados trazem parte `image/*` **E** InsightFace acha ≥1 rosto com `det_score ≥ 0.5` e bbox ≥ **80×80 px** em ≥ **80%** dessas imagens |
| **(b) viável** | `snapshot.cgi` responde `image/*` em ≥ **95%** **E** rosto utilizável (mesmo score/px) em ≥ **70%** **E** Δ-timing evento↔snapshot mediano ≤ **2000 ms** |
| **(c)** | (a) e (b) reprovam → recomenda onda follow-up RTSP (não construída aqui) |
| **(d)** | (a)+(b) reprovam **e** evidência indica ausência de rosto utilizável (imagens sem face / resolução insuficiente) → Failover B inviável neste hardware |

**Amostra mínima:** ≥ **30 eventos de face** capturados; senão relatório = "inconclusivo — repetir janela em horário de mais movimento".

---

## 6. Erros, edge cases & segurança operacional

- **Integridade do ingest é prioridade absoluta:** probe-mode default OFF (tap no-op); tap síncrono mantido barato (cópia + scan boundary); escrita de amostra fire-and-forget com fila limitada (descarta sob backpressure, nunca trava o socket); exceção no tap/extrator capturada e logada, loop do ingest continua.
- **Disco & auto-expira:** amostras bounded por teto de contagem + orçamento de bytes; recusa iniciar com disco baixo; cap duro de janela ≤60min com auto-expire mesmo sem `stop`; comando de limpeza dedicado; start/stop idempotente + status.
- **Validação resiliente & desacoplada:** amostras persistem → re-rodável sem recapturar; reid down/lento → relatório marca indisponível, agrega sucessos + conta falhas; timeout por imagem.
- **Câmera:** `snapshot.cgi` 401/404/timeout → status registrado (reusa enums do probe `snapshot.fetch` existente); (b) reprova com motivo. 0 eventos / <30 amostras → inconclusivo.
- **Limpeza das amostras:** comando dedicado; recomendado pós-decisão (justificativa operacional/disco; privacidade/retention é o débito LGPD separado, fora desta onda).
- **Segurança:** controle via `/api/discovery/*` já protegido por `requireKey`.

---

## 7. Estratégia de testes

- **Unit (offline, sem câmera) — TDD no de maior risco:**
  - `parseMultipartPartsRaw`: buffers multipart sintéticos — parte texto, parte `image/jpeg` com bytes binários **contendo sequências tipo-boundary**, parte dividida entre chunks → headers/bytes preservados, binário não corrompido (utf8), `remainder` correto.
  - Agregador de decisão/thresholds: resultados sintéticos de `/detect` → conclusão a/b/c/d + "inconclusivo (<30)" + parametrização dos thresholds.
  - Guard do probe-mode: tap ausente → `consumeStream` idêntico ao atual; tap que lança → eventos ainda despachados (ingest não quebra).
- **Edge↔reid:** client HTTP unit com reid mockado (contrato `/detect`).
- **reid (pytest):** `/detect` com fixture de rosto conhecido → ≥1 face; imagem em branco → 0 faces; `/health`.
- **Sem câmera em testes:** câmera real só na execução operacional do probe (o relatório empírico É o artefato — não vira teste de CI).
- **InsightFace/reid em CI/local:** rodar onde sidecar+modelo existem; localmente deferido como nas outras ondas de infra (documentado).

---

## 8. Validação operacional (o artefato desta onda)

Rodar o probe no VPS em **horário de movimento** (barbearia: 50–160 clientes/dia, pico tarde), janela ≤60min, ≥30 eventos de face; rodar a validação; produzir o doc de decisão a/b/c/d. Esse relatório é o gate resolvido e a entrada do spec do Failover B (onda seguinte). Limpeza das amostras após decisão.

---

## 9. Próximos passos

1. Spec aprovado (este doc) → spec-document-reviewer valida.
2. `superpowers:writing-plans` gera plano detalhado (TDD onde aplicável).
3. Execução por `superpowers:subagent-driven-development`.
4. Deploy no VPS + **execução operacional do probe** → relatório de decisão.
5. Failover B vira onda seguinte, já informada por evidência (ou reavaliação de estratégia se 'd').
