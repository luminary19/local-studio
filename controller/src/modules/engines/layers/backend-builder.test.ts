import { describe, expect, it } from "bun:test";
import type { Config } from "../../../config/env";
import { asRecipeId } from "../../../types/brand";
import type { Recipe } from "../../models/types";
import { buildBackendCommand } from "./backend-builder";

const baseRecipe: Recipe = {
  id: asRecipeId("r1"),
  name: "custom",
  model_path: "/models/test",
  backend: "sglang",
  env_vars: null,
  tensor_parallel_size: 1,
  pipeline_parallel_size: 1,
  max_model_len: 32768,
  gpu_memory_utilization: 0.9,
  kv_cache_dtype: "auto",
  max_num_seqs: 256,
  trust_remote_code: true,
  tool_call_parser: null,
  reasoning_parser: null,
  enable_auto_tool_choice: false,
  quantization: null,
  dtype: null,
  host: "0.0.0.0",
  port: 8000,
  served_model_name: null,
  python_path: null,
  extra_args: {},
  max_thinking_tokens: null,
  thinking_mode: "conservative",
};

describe("backend builder command overrides", () => {
  it("uses launch_command as the full launch argv", () => {
    const command = buildBackendCommand(
      {
        ...baseRecipe,
        extra_args: {
          launch_command:
            "python -m sglang.launch_server --model-path /models/custom --grammar-backend xgrammar",
        },
      },
      {} as Config,
    );

    expect(command).toEqual([
      "python",
      "-m",
      "sglang.launch_server",
      "--model-path",
      "/models/custom",
      "--grammar-backend",
      "xgrammar",
    ]);
  });

  it("normalizes multiline command continuations from the editor", () => {
    const command = buildBackendCommand(
      {
        ...baseRecipe,
        extra_args: {
          launch_command:
            "python -m sglang.launch_server \\\n+  --model-path '/models/custom model' \\\n+  --enable-metrics",
        },
      },
      {} as Config,
    );

    expect(command).toEqual([
      "python",
      "-m",
      "sglang.launch_server",
      "--model-path",
      "/models/custom model",
      "--enable-metrics",
    ]);
  });
});
