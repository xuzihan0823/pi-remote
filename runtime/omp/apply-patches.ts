import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "node_modules/@oh-my-pi/pi-coding-agent");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
if (version !== "18.6.3") throw new Error("Unsupported controlled OMP version");

function patch(file: string, replacements: [string, string][]) {
  const path = join(root, file);
  let text = readFileSync(path, "utf8");
  for (const [before, after] of replacements) {
    if (text.includes(after)) continue;
    if (text.split(before).length !== 2) throw new Error(`Controlled runtime patch anchor mismatch: ${file}`);
    text = text.replace(before, after);
  }
  writeFileSync(path, text);
}

patch("src/config/model-resolver.ts", [[
  "\t\tconst level = requested?.level;\n\t\tif (level) return { patterns: patterns.map(pattern => applyRequestedThinkingLevel(pattern, level)) };",
  "\t\tconst level = requested?.level;\n\t\tif (process.env.PI_REMOTE_SUBAGENT_MODELS !== undefined) {\n\t\t\tconst independent: string[] = JSON.parse(process.env.PI_REMOTE_SUBAGENT_MODELS);\n\t\t\tif (!independent.length) throw new Error(\"No independent subagent model configured\");\n\t\t\treturn { patterns: level ? independent.map(pattern => applyRequestedThinkingLevel(pattern, level)) : independent };\n\t\t}\n\t\tif (level) return { patterns: patterns.map(pattern => applyRequestedThinkingLevel(pattern, level)) };",
], [
  "\tconst overridePatterns = resolveConfiguredModelPatterns(settingsOverride, settings);",
  "\tconst overrideInheritance = normalizeModelPatternList(settingsOverride);\n\tif (process.env.PI_REMOTE_SUBAGENT_MODELS !== undefined && overrideInheritance.length === 1 && matchSessionInheritedPattern(overrideInheritance[0])) return inheritSessionModel(matchSessionInheritedPattern(overrideInheritance[0]));\n\tconst overridePatterns = resolveConfiguredModelPatterns(settingsOverride, settings);",
]]);

patch("src/task/executor.ts", [[
  "\t\t\t\t\toptions.parentActiveModelPattern,",
  "\t\t\t\t\tprocess.env.PI_REMOTE_SUBAGENT_MODELS === undefined ? options.parentActiveModelPattern : undefined,",
], [
  "model || modelOverride === undefined ? undefined : options.parentActiveModelPattern,",
  "model || modelOverride === undefined || process.env.PI_REMOTE_SUBAGENT_MODELS !== undefined ? undefined : options.parentActiveModelPattern,",
]]);

patch("src/task/structured-subagent.ts", [[
  "\tconst parentActiveModelPattern = request.session.getActiveModelString?.();",
  "\tconst parentActiveModelPattern = process.env.PI_REMOTE_SUBAGENT_MODELS === undefined ? request.session.getActiveModelString?.() : undefined;",
]]);
patch("src/config/model-resolver.ts", [[
  "\tconst { requestModel, settingsOverride, agentModel, settings, activeModelPattern, fallbackModelPattern } = options;",
  "\tconst { requestModel, settingsOverride, agentModel, settings: originalSettings, activeModelPattern, fallbackModelPattern } = options;\n\tconst settings = process.env.PI_REMOTE_SUBAGENT_MODELS === undefined ? originalSettings : {\n\t\tgetModelRole: (role: string) => role === \"default\" ? JSON.parse(process.env.PI_REMOTE_SUBAGENT_MODELS!).join(\",\") : originalSettings?.getModelRole(role),\n\t};",
], [
  "\treturn `${pattern}:${level}`;",
  "\treturn `${splitThinkingSuffix(pattern, -1, MAX_THINKING_SUFFIX_OPTIONS).base}:${level}`;",
], [
  "\tauthFallbackUsed: boolean;\n\twarning?: string;\n}> {\n\tconst disabledProviders = disabledProviderIds(settings);",
  "\tauthFallbackUsed: boolean;\n\twarning?: string;\n}> {\n\tif (process.env.PI_REMOTE_SUBAGENT_MODELS !== undefined) parentActiveModelPattern = undefined;\n\tconst disabledProviders = disabledProviderIds(settings);",
], [
  "\tconst patterns = resolveConfiguredModelPatterns(modelPatterns, settings);\n\tconst primary = resolveModelOverride(patterns, lookupRegistry, settings);",
  "\tconst patterns = process.env.PI_REMOTE_SUBAGENT_MODELS === undefined ? resolveConfiguredModelPatterns(modelPatterns, settings) : resolveAgentModelPatterns({ requestModel: modelPatterns, settings });\n\tconst primary = resolveModelOverride(patterns, lookupRegistry, settings);",
]]);

patch("src/task/executor.ts", [[
  "\tresolveAgentAdvisorSelection,",
  "\tresolveAgentAdvisorSelection,\n\tresolveAgentModelPatterns,",
], [
  "\treturn fallbackChain.filter(entry => {",
  "\tconst independentChain = process.env.PI_REMOTE_SUBAGENT_MODELS === undefined ? fallbackChain : resolveAgentModelPatterns({ requestModel: fallbackChain, settings });\n\treturn independentChain.filter(entry => {",
], [
  "\t\t\tif (modelResolutionWarning) {",
  "\t\t\tif (process.env.PI_REMOTE_SUBAGENT_MODELS !== undefined && !model) throw new Error(\"Independent subagent model unavailable; parent fallback is forbidden\");\n\t\t\tif (modelResolutionWarning) {",
]]);
patch("src/modes/rpc/rpc-mode.ts", [[
  "\t\tasync custom(): Promise<never> {\n\t\t\t// Custom UI not supported in RPC mode\n\t\t\treturn undefined as never;\n\t\t}",
  "\t\tasync custom(): Promise<never> {\n\t\t\tthrow new Error(\"Pi Remote 后台不支持自定义终端 UI；请在 Mac 完成本次交互，没有自动批准。\");\n\t\t}",
]]);
console.log("Controlled OMP 18.6.3 subagent isolation patches verified");
