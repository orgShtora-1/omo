import { OptionsError } from "./schema"

/** Strip comments and trailing commas only outside strings, retaining source offsets. */
export function parseJSONC(source: string, path = "omo.jsonc"): unknown {
  const chars = [...source.replace(/^\uFEFF/, " ")]
  let quoted = false
  let escaped = false
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') quoted = false
      continue
    }
    if (c === '"') {
      quoted = true
      continue
    }
    if (c !== "/") continue
    if (chars[i + 1] === "/") {
      while (i < chars.length && chars[i] !== "\n" && chars[i] !== "\r") chars[i++] = " "
      i--
    } else if (chars[i + 1] === "*") {
      const start = i
      chars[i++] = " "
      chars[i++] = " "
      while (i < chars.length && !(chars[i] === "*" && chars[i + 1] === "/")) {
        if (chars[i] !== "\n" && chars[i] !== "\r") chars[i] = " "
        i++
      }
      if (i >= chars.length) throw new OptionsError(path, `unterminated comment at offset ${start}`)
      chars[i] = chars[++i] = " "
    }
  }
  quoted = false
  escaped = false
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') quoted = false
    } else if (c === '"') quoted = true
    else if (c === ",") {
      let next = i + 1
      while (/\s/.test(chars[next] ?? "x")) next++
      let previous = i - 1
      while (/\s/.test(chars[previous] ?? "x")) previous--
      if (
        (chars[next] === "}" || chars[next] === "]") &&
        !["[", "{", ",", ":"].includes(chars[previous] ?? "")
      )
        chars[i] = " "
    }
  }
  try {
    return JSON.parse(chars.join(""))
  } catch (error) {
    throw new OptionsError(
      path,
      `invalid JSONC: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
}
