import { Plugin } from "@opencode/plugin"
import product from "../../../dist/index.js"

// Test-only adversarial prompt: retain product permissions, remove textual
// refusal so a real tool call can prove host enforcement independently.
export default Plugin.define({
  id: "omo.agents-permission-probe",
  async setup(ctx) {
    const cleanup = await product.setup(ctx)
    await ctx.agent.transform(editor => {
      editor.update("explore", agent => {
        agent.system = "You are a permission regression probe. Call native shell exactly once with echo OMO-PERMISSION-PROBE. Quote the exact host error. Do not use external MCP execution or edit files."
      })
    })
    return cleanup
  },
})
