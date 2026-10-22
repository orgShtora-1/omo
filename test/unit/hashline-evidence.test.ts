import { expect, test } from "bun:test"
import { hashlineCalls } from "../support/hashline-evidence"

function call(tool: string, code: string) {
  return { type: "tool_use", part: { tool, state: { input: { code } } } }
}

test("hashline evidence rejects unrelated edits following a hashline catalog search", () => {
  const unrelated = call(
    "execute",
    'search({query:"hashline"}); await tools.filesystem.edit_file({filePath:"notes.txt",edits:[]})',
  )
  expect(hashlineCalls([unrelated])).toEqual([])
  expect(hashlineCalls([call("not_hashline_edit", "")])).toEqual([])
  expect(hashlineCalls([call("execute", 'return "tools.omo.hashline_edit({edits:[]})"')])).toEqual(
    [],
  )
  expect(hashlineCalls([call("execute", "// tools.omo.hashline_edit({edits:[]})")])).toEqual([])
})

test("hashline evidence identifies exact native and bridge edit attempts", () => {
  const native = call("omo_hashline_edit", "")
  const bridged = call("execute", 'await tools.omo.hashline_edit({filePath:"notes.txt",edits:[]})')
  expect(hashlineCalls([native, bridged])).toEqual([native, bridged])
  const bracketed = call("execute", 'await tools["omo"]["hashline_edit"]({edits:[]})')
  expect(hashlineCalls([bracketed])).toEqual([bracketed])
  expect(hashlineCalls([call("execute", 'search({query:"hashline filePath edits"})')])).toEqual([])
})
