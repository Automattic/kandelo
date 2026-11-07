/** Read complete upstream case records without treating a partial log as success. */
export function parseCtsQpa(text, expected) {
  if (new Set(expected).size !== expected.length || expected.length === 0) {
    throw new Error("CTS selection must contain unique case names");
  }
  const rows = [], incomplete = [];
  for (const chunk of text.split("#beginTestCaseResult ").slice(1)) {
    const path = chunk.split(/\r?\n/, 1)[0].trim();
    const end = chunk.indexOf("#endTestCaseResult");
    const xml = end < 0 ? "" : chunk.slice(0, end);
    const results = [...xml.matchAll(/<Result\s+StatusCode="([^"]+)"[^>]*>([\s\S]*?)<\/Result>/g)];
    const xmlPath = /<TestCaseResult\s[^>]*\bCasePath="([^"]+)"/.exec(xml)?.[1];
    if (results.length !== 1 || xmlPath !== path || !xml.includes("</TestCaseResult>")) {
      incomplete.push(path);
      continue;
    }
    rows.push({ path, status: results[0][1], description: results[0][2] });
  }
  const expectedSet = new Set(expected), seen = new Set(), duplicates = [];
  const counts = {};
  for (const row of rows) {
    if (seen.has(row.path)) duplicates.push(row.path);
    seen.add(row.path);
    counts[row.status] = (counts[row.status] ?? 0) + 1;
  }
  return {
    rows, counts, incomplete, duplicates,
    missing: expected.filter(path => !seen.has(path)),
    unexpected: rows.filter(row => !expectedSet.has(row.path)).map(row => row.path),
  };
}

/** Complete pinned negative-state group; no failing cases are excluded. */
export const GLES2_NEGATIVE_STATE_CASES = [
  "disable", "enable", "get_attached_shaders", "get_booleanv",
  "get_buffer_parameteriv", "get_floatv", "get_framebuffer_attachment_parameteriv",
  "get_integerv", "get_is_enabled", "get_program_info_log", "get_programiv",
  "get_renderbuffer_parameteriv", "get_shader_info_log", "get_shader_precision_format",
  "get_shader_source", "get_shaderiv", "get_string", "get_tex_parameterfv",
  "get_tex_parameteriv", "get_uniformfv", "get_uniformiv", "get_vertex_attrib_pointerv",
  "get_vertex_attribfv", "get_vertex_attribiv", "hint", "is_buffer", "is_framebuffer",
  "is_program", "is_renderbuffer", "is_shader", "is_texture",
].map(name => `dEQP-GLES2.functional.negative_api.state.${name}`);
