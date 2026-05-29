# Employee Photo Fixtures

Fixtures p/ integration tests do Onda 9-B (`employee-face-seeder-integration.test.ts`).

## Conteúdo esperado

- `test-face.jpg` — JPEG real contendo 1 face frontal claramente visível. ~50-200 KB.

## Por que não está committed

Imagens binárias com PII (mesmo de pessoa fictícia) não pertencem ao repo se evitável. Os tests skipam graciosamente quando o fixture não existe, permitindo:
- Dev local sem fixture: testa skipa, suite continua
- VPS produção: operador provê uma vez via opção (b) ou (c) abaixo

## Como obter

Escolha 1:

**(a) Foto stock CC0** — baixar de Pexels/Unsplash uma foto frontal de face. Salvar como `test-face.jpg` neste dir. **Atenção:** verificar licença permite uso em CI.

**(b) Foto sintética via InsightFace** — usar imagens de teste do próprio InsightFace (já no venv do `vipcam-reid`):
```bash
cp packages/reid/.venv/lib/python*/site-packages/insightface/data/images/t1.jpg \
   packages/edge/tests/fixtures/employee-photos/test-face.jpg
```

**(c) Captura real da câmera durante dev** — capturar 1 frame da câmera DH-IPC com 1 face frontal:
```bash
curl -s "http://CAMERA_IP/cgi-bin/snapshot.cgi?channel=1" \
  -u "admin:senha" > packages/edge/tests/fixtures/employee-photos/test-face.jpg
```

## Documentar a escolha

Após adicionar o fixture, anotar abaixo qual origem foi usada + data (audit trail):

```
- 2026-XX-XX: usada opção (X) — <fonte/URL>
```
