import { afterEach } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// DOM globals PRIMEIRO — @testing-library/react precisa de `document` no
// momento do import, então só importamos cleanup DEPOIS do register.
GlobalRegistrator.register();

const { cleanup } = require("@testing-library/react") as typeof import("@testing-library/react");

// @testing-library/react NÃO tem auto-cleanup com bun:test (só com
// jest/vitest globals). Sem isso render() acumula DOM entre testes →
// getByText acha múltiplos matches (ex: <VisitCard> passa isolado mas
// falha no suite com "Found multiple elements with the text").
afterEach(() => {
  cleanup();
});
