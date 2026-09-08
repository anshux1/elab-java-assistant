import type { SolveRequest } from "./schema";
import { AppError, type Issue } from "./errors";

type Token = { value: string; start: number; end: number; literal: boolean };
type JavaMetrics = { cyclomaticComplexity: number; tokenCount: number; nloc: number };

// Preserve source positions; comments and literals cannot impersonate declarations.
function lex(source: string) {
  const tokens: Token[] = [];
  const mask = source.split("");
  let incomplete = false;
  const hide = (start: number, end: number) => {
    for (let i = start; i < end; i++) if (mask[i] !== "\n" && mask[i] !== "\r") mask[i] = " ";
  };
  for (let i = 0; i < source.length;) {
    if (/\s/.test(source[i])) { i++; continue; }
    const start = i;
    if (source.startsWith("//", i)) {
      const end = source.indexOf("\n", i);
      i = end < 0 ? source.length : end;
      hide(start, i);
      continue;
    }
    if (source.startsWith("/*", i)) {
      const end = source.indexOf("*/", i + 2);
      incomplete ||= end < 0;
      i = end < 0 ? source.length : end + 2;
      hide(start, i);
      continue;
    }
    const quote = source.startsWith('"""', i) ? '"""' : /["']/.test(source[i]) ? source[i] : null;
    if (quote) {
      i += quote.length;
      let closed = false;
      while (i < source.length) {
        if (source[i] === "\\") { i = Math.min(i + 2, source.length); continue; }
        if (source.startsWith(quote, i)) { i += quote.length; closed = true; break; }
        if (quote.length === 1 && /[\r\n]/.test(source[i])) { incomplete = true; break; }
        i++;
      }
      incomplete ||= !closed;
      tokens.push({ value: source.slice(start, i), start, end: i, literal: true });
      hide(start, i);
      continue;
    }
    const value = source.slice(i).match(/^(?:[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|>>>=|>>=|<<=|>>>|>>|<<|\.\.\.|::|->|\+\+|--|&&|\|\||==|!=|<=|>=|[+\-*/%&|^]=|[^\s])/u)![0];
    i += value.length;
    tokens.push({ value, start, end: i, literal: false });
  }
  return { tokens, masked: mask.join(""), incomplete };
}

const classPattern = /\bpublic\s+(?:(?:final|abstract|strictfp|static)\s+)*class\s+([\p{L}_$][\p{L}\p{N}_$]*)/u;
const mainPattern = /\bstatic\s+(?:(?:public|final|synchronized|strictfp)\s+)*void\s+main\s*\(/;

export function extractPublicClassName(source: string): string | null {
  return lex(source).masked.match(classPattern)?.[1] ?? null;
}

export function extractJavaCode(responseText: string): string {
  const trimmed = responseText.trim().replace(/^java\s*\r?\n/i, "");
  // Inspect all fences: an introductory text fence must not hide the actual Java.
  const fences = [...trimmed.matchAll(/^\s*(`{3,}|~{3,})[^\S\r\n]*([^\r\n]*)\r?\n([\s\S]*?)^\s*\1\s*$/gm)];
  const candidates = fences
    .filter((match) => /^(?:java|jav|)\s*$/i.test(match[2]))
    .map((match) => match[3].trim())
    .filter((code) => /\bclass\s+/u.test(lex(code).masked));
  if (candidates.length > 1) throw new AppError("INVALID_SOLUTION", [{ code: "MULTIPLE_SOLUTIONS", message: "Return one complete Java source file, not multiple code blocks." }]);
  if (candidates.length === 1) return candidates[0];
  // Accept an unclosed Markdown fence, but validate the Java itself for truncation.
  const unwrapped = trimmed.replace(/^\s*(?:`{3,}|~{3,})(?:java)?[^\S\r\n]*\r?\n/i, "");
  const masked = lex(unwrapped).masked;
  const start = masked.search(/^[\t ]*(?:package\s|import\s|@[\p{L}_$]|(?:(?:public|final|abstract|strictfp)\s+)*class\s)/mu);
  if (start < 0) return unwrapped;
  // Preserve modifiers, annotations, imports, helpers and string contents verbatim.
  // Only remove a trailing Markdown closing fence; never cut at an arbitrary '}'.
  let source = unwrapped.slice(start).replace(/\r?\n\s*(?:`{3,}|~{3,})\s*$/, "").trim();
  const codeMask = lex(source).masked;
  const end = codeMask.lastIndexOf("}") + 1;
  const suffix = source.slice(end);
  // Recognizable prose after the source is wrapping, not part of the program.
  // Never trim an additional class or an arbitrary incomplete Java declaration.
  if (end && /^\s*(?:(?:Explanation|Note|Output|Time complexity|Space complexity)\s*:|(?:This|The|It)\s)/i.test(suffix)
    && !/\b(?:class|interface|enum)\s+/.test(suffix)) source = source.slice(0, end);
  return source.trim();
}

export function mandatoryFragments(input: SolveRequest): string[] {
  return [...new Set(input.mandatory.flatMap((card) => card.fields
    .filter((field) => {
      const label = field.label.toLowerCase();
      if (/\b(?:description|explanation|score|weight|marks|count|status)\b/.test(label)) return false;
      return /\b(?:code|keyword|statement|fragment|construct|syntax)\b/.test(label)
        || /[;{}()=]|^(?:for|while|if|switch|class|static|public|private|protected|return|break|continue)$/.test(field.value.trim());
    })
    .map((field) => field.value.trim())
    .filter(Boolean)))];
}

function containsFragment(tokens: Token[], fragment: string): boolean {
  const wanted = lex(fragment).tokens;
  if (!wanted.length) return true;
  return tokens.some((_, i) => wanted.every((token, j) => tokens[i + j]?.value === token.value));
}

export function measureJavaSource(source: string): JavaMetrics {
  const { tokens, masked } = lex(source);
  const decisions = tokens.filter((token) => !token.literal && /^(?:if|for|while|case|catch|&&|\|\||\?)$/.test(token.value)).length;
  return {
    cyclomaticComplexity: 1 + decisions,
    tokenCount: tokens.length,
    nloc: masked.split(/\r?\n/).filter((line) => line.trim()).length
  };
}

function findLimit(input: SolveRequest, pattern: RegExp): number | undefined {
  for (const card of input.complexity) {
    for (const field of card.fields) {
      if (pattern.test(field.label)) {
        const value = field.value.match(/\b\d+(?:\.\d+)?\b/);
        if (value) return Number(value[0]);
      }
      const match = `${field.label} ${field.value}`.match(new RegExp(`${pattern.source}\\D*(\\d+(?:\\.\\d+)?)`, "i"));
      if (match) return Number(match[1]);
    }
  }
  return undefined;
}

export function validateSolution(source: string, input: SolveRequest): { errors: Issue[]; warnings: Issue[] } {
  const { tokens, masked, incomplete } = lex(source);
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const requiredClass = extractPublicClassName(input.starterCode);
  if (!/\bclass\s+[\p{L}_$]/u.test(masked)) errors.push({ code: "MISSING_CLASS", message: "Return a complete Java class." });
  if (requiredClass && extractPublicClassName(source) !== requiredClass) errors.push({ code: "CLASS_NAME", message: `The public class must be ${requiredClass}.` });
  if (!mainPattern.test(masked)) errors.push({ code: "MISSING_MAIN", message: "Include the required static void main method." });
  const stack: string[] = [];
  const pairs: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  let unbalanced = false;
  for (const token of tokens) {
    if (token.literal) continue;
    if (/^[{(\[]$/.test(token.value)) stack.push(token.value);
    else if (pairs[token.value] && stack.pop() !== pairs[token.value]) unbalanced = true;
  }
  let endIndex = tokens.length - 1;
  while (tokens[endIndex]?.value === ";") endIndex--;
  const lastDeclarationToken = tokens[endIndex];
  if (incomplete || unbalanced || stack.length || lastDeclarationToken?.value !== "}") {
    errors.push({ code: "INCOMPLETE_JAVA", message: "Return complete Java with closed literals and balanced braces, parentheses and brackets, without trailing prose." });
  }
  for (const fragment of mandatoryFragments(input)) {
    if (!containsFragment(tokens, fragment)) warnings.push({ code: "MANDATORY_FRAGMENT", message: `Check the required construct: ${fragment.slice(0, 100)}` });
  }
  const metrics = measureJavaSource(source);
  const limits: Array<[string, string, number | undefined, number]> = [
    ["ESTIMATED_COMPLEXITY", "cyclomatic complexity", findLimit(input, /cyclomatic\s+complexity/i), metrics.cyclomaticComplexity],
    ["ESTIMATED_TOKEN_COUNT", "token count", findLimit(input, /token\s+count/i), metrics.tokenCount],
    ["ESTIMATED_NLOC", "NLOC", findLimit(input, /\bnloc\b/i), metrics.nloc]
  ];
  for (const [code, name, limit, actual] of limits) {
    if (limit !== undefined && actual > limit) warnings.push({ code, message: `Estimated ${name} is ${actual}; listed target is ${limit}. Verify with the grader.` });
  }
  return { errors, warnings: warnings.slice(0, 20) };
}
