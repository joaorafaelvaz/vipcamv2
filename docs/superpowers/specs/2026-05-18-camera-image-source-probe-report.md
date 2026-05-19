# Camera Image-Source Probe — Relatório de Decisão (gate Failover B)

**Data da execução:** 2026-05-19 (VPS, câmera real, horário de operação)
**Run:** `run-2026-05-19T14-48-19-333Z`
**Status:** Gate resolvido — decisão humana registrada (caso borderline)
**Spec:** `docs/superpowers/specs/2026-05-18-camera-image-source-probe-design.md`

---

## 1. Resultado bruto (37 eventos de face capturados)

| Fonte | Amostras | Com imagem | Rosto utilizável | bbox mediano px | infer mediano ms | Δ mediano ms |
|---|---|---|---|---|---|---|
| event (a) | 0 | 0 | 0 | — | — | — |
| snapshot (b) | 37 | 37 | 23 | ~87.3 | 97 | 721 |

- `event: img_rate=0.00` — o stream `eventManager.cgi` é **metadata-only**; **zero** partes `image/*` em 37 eventos de face. **Opção (a) descartada empiricamente.**
- `snapshot: img_rate=1.00` — `snapshot.cgi` **sempre** respondeu `200 image/jpeg`, **temporalmente alinhado** (Δ mediano **721 ms** ≤ 2000 ms).
- `face_rate=0.62` — **23/37** snapshots tinham rosto utilizável (det_score ≥ 0.5 **e** bbox ≥ 80 px) rodando InsightFace `buffalo_s` no **frame inteiro 2688×1520**.
- `median_bbox_px ≈ 87` — rostos ficam **minúsculos** no frame cheio (logo acima do piso de 80 px), o que explica os ~38% sem rosto utilizável (face pequena/distante/virada no instante do snapshot).

Conclusão automática do `decide()`: **`d_infeasible`** (porque nem (a) nem (b) cruzou o threshold estrito `min_face_rate 0.8`, e há imagens → ramo "imagens sem rosto utilizável").

## 2. Revisão humana (a spec exigia: probe não decide sozinho em borderline)

O `d_infeasible` automático **não é um veredito limpo** — é o resultado do threshold estrito de 0.8 vs. 0.62 observado:

- `0.62 ≠ "sem rosto utilizável"`: a maioria dos snapshots **tem** rosto detectável. A mensagem do `decide()` ("câmera entrega imagens mas sem rosto utilizável") **superestima** o problema para este dado.
- Causa-raiz do gap: InsightFace roda no **frame cheio 2688×1520**; o rosto reportado pelo evento ocupa ~87 px → perto do piso, score baixo, ~38% perdidos.
- **Alavanca de design (a descoberta-chave do probe):** o stream de evento, apesar de metadata-only, **carrega as coordenadas de bounding-box do rosto** (`FaceDetection`). Recortar o `snapshot.cgi` alinhado para a **região de rosto reportada pelo evento** antes do embedding deve elevar drasticamente score/tamanho efetivo e empurrar a taxa utilizável bem acima de 0.8.

**Decisão humana (Rafael, 2026-05-19):** tratar como **VIÁVEL via snapshot.cgi + crop pela bbox do evento**. Failover B segue como próxima onda, desenhado sobre: `FaceDetection` event (bbox + timing) → `snapshot.cgi` alinhado (~721 ms) → **crop pela bbox** → embedding InsightFace.

## 3. Fatos empíricos confirmados (entrada do design do Failover B)

- Código de evento de face Dahua deste hardware: **`FaceDetection`**.
- Evento NÃO embute imagem (metadata-only) — re-id precisa de fonte de imagem externa ao evento.
- `snapshot.cgi?channel=1` → `200 image/jpeg` ~**2688×1520**, **~721 ms** após o evento (alinhamento aceitável).
- InsightFace `buffalo_s` CPU no VPS: **~97 ms/inferência** (warm; cold-start ~5,5 s, uma vez). Stack reid de pé e validada (`/health`, `/detect`).
- Sidecar `vipcam-reid` operacional: `uv` vendorizado em `/usr/local/bin/uv`; venv recriado como `vipcam` (cpython-3.11 gerenciada em `/var/lib/vipcam/.local/share/uv`); modelo em `/var/lib/vipcam/.insightface/models/buffalo_s`.

## 4. Limitação conhecida do `decide()` (débito, não bloqueia)

A spec pedia "num borderline marca 'revisão humana'", mas o `decide()` implementado vai direto a `d_infeasible` quando (b) falha por qualquer margem — sem estado intermediário "borderline/needs-review". A revisão humana aconteceu manualmente aqui. Se uma lógica de decisão por taxa-utilizável for reaproveitada no Failover B, **incluir um estado borderline** (ex.: `min_face_rate` não atingido mas `≥0.5` → flag de revisão, não `d`). Registrado como input do design da Onda 7; não vale reabrir o módulo one-shot da Onda 6 (YAGNI).

## 5. Próximos passos

1. Onda 6 fechada (código mergeado `a6f73a1` + fixes operacionais `319e6a6`; este relatório é o entregável).
2. Parar o probe + limpar amostras (rostos reais; sem propósito pós-decisão — LGPD é débito separado).
3. **Onda 7 — Failover B**: brainstorming com esta evidência (snapshot+crop pela bbox do evento). Gate resolvido = VIÁVEL condicional ao crop.
