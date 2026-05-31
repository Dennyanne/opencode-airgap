/**
 * AC9: changing VLLM_BASE_URL / VLLM_MODEL / VLLM_API_KEY env vars affects the
 * vLLM connection without rebuilding.
 *
 * This is a static structural test — no live exe required.
 *
 * Sub-check A: templates/opencode.json contains the three {env:VAR} placeholders.
 * Sub-check B: templates/opencode-airgap.config.json exists, parses as valid
 *              JSON, and contains a provider.vllm.options.baseURL field.
 */
import { existsSync, readFileSync } from "fs";
import { pass, fail } from "./util.ts";

const LABEL_A = "AC9-A: opencode.json has {env:VLLM_*} placeholders";
const LABEL_B = "AC9-B: opencode-airgap.config.json has provider.vllm.options.baseURL";
const TEMPLATE_JSON = "templates/opencode.json";
const CONFIG_JSON = "templates/opencode-airgap.config.json";

export function runAc9(): void {
  // --- Sub-check A ---
  if (!existsSync(TEMPLATE_JSON)) {
    fail(LABEL_A, `${TEMPLATE_JSON} not found`);
  } else {
    let content: string;
    try {
      content = readFileSync(TEMPLATE_JSON, "utf-8");
    } catch (err) {
      fail(LABEL_A, `cannot read ${TEMPLATE_JSON}: ${err instanceof Error ? err.message : String(err)}`);
      // Fall through to sub-check B.
      runAc9B();
      return;
    }

    const missing: string[] = [];
    for (const placeholder of ["{env:VLLM_BASE_URL}", "{env:VLLM_API_KEY}", "{env:VLLM_MODEL}"]) {
      if (!content.includes(placeholder)) missing.push(placeholder);
    }
    if (missing.length > 0) {
      fail(LABEL_A, `missing placeholders: ${missing.join(", ")}`);
    } else {
      pass(LABEL_A);
    }
  }

  runAc9B();
}

function runAc9B(): void {
  if (!existsSync(CONFIG_JSON)) {
    fail(LABEL_B, `${CONFIG_JSON} not found`);
    return;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_JSON, "utf-8"));
  } catch (err) {
    fail(LABEL_B, `invalid JSON in ${CONFIG_JSON}: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }

  // Drill into provider.vllm.options.baseURL.
  if (
    typeof parsed !== "object" ||
    parsed === null
  ) {
    fail(LABEL_B, `${CONFIG_JSON} root is not an object`);
    return;
  }

  const root = parsed as Record<string, unknown>;
  const provider = root["provider"];
  if (typeof provider !== "object" || provider === null) {
    fail(LABEL_B, `${CONFIG_JSON} missing "provider" object`);
    return;
  }

  const vllm = (provider as Record<string, unknown>)["vllm"];
  if (typeof vllm !== "object" || vllm === null) {
    fail(LABEL_B, `${CONFIG_JSON} missing "provider.vllm" object`);
    return;
  }

  const options = (vllm as Record<string, unknown>)["options"];
  if (typeof options !== "object" || options === null) {
    fail(LABEL_B, `${CONFIG_JSON} missing "provider.vllm.options" object`);
    return;
  }

  const baseURL = (options as Record<string, unknown>)["baseURL"];
  if (typeof baseURL !== "string" || baseURL.length === 0) {
    fail(LABEL_B, `${CONFIG_JSON} "provider.vllm.options.baseURL" is missing or empty`);
    return;
  }

  pass(LABEL_B);
}
