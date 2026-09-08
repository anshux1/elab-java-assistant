import { describe, expect, it } from "vitest";
import { extractJavaCode, extractPublicClassName, mandatoryFragments, validateSolution } from "../src/java";
import { code, input } from "./inputs";

describe("Java acceptance", () => {
  it("preserves unfenced modifiers and literal whitespace", () => {
    expect(extractJavaCode(code)).toBe(code);
    expect(validateSolution(code, input).errors).toEqual([]);
  });
  it("selects Java after a text fence and accepts CRLF or tilde fences", () => {
    expect(extractJavaCode('Example:\n```text\nhello\n```\n```java\n' + code + '\n```\nExplanation')).toBe(code);
    expect(extractJavaCode('~~~java\r\n' + code + '\r\n~~~')).toBe(code);
  });
  it("preserves annotations and static imports", () => {
    const source = 'import static java.lang.System.out;\n@Deprecated\n' + code;
    expect(extractJavaCode('Here is the solution:\n' + source)).toBe(source);
  });
  it("accepts recognizable trailing prose and legal top-level semicolons", () => {
    expect(extractJavaCode(code + '\nThis solution prints the greeting.')).toBe(code);
    expect(validateSolution(code + ';', input).errors).toEqual([]);
    expect(validateSolution(extractJavaCode(code + '\nclass Helper {'), input).errors.map(x => x.code)).toContain("INCOMPLETE_JAVA");
  });
  it("rejects ambiguous complete alternatives", () => {
    expect(() => extractJavaCode('```java\n' + code + '\n```\n```java\n' + code + '\n```')).toThrow();
  });
  it("checks Java truncation separately from a missing closing fence", () => {
    expect(validateSolution(extractJavaCode('```java\n' + code), input).errors).toEqual([]);
    expect(validateSolution(code.slice(0, -1), input).errors.map(x => x.code)).toContain("INCOMPLETE_JAVA");
  });
  it("ignores declarations and delimiters in comments and literals", () => {
    const source = 'class Other { String s = "public class Main { static void main("; /* public class Main {} */ }';
    expect(extractPublicClassName(source)).toBeNull();
    expect(validateSolution(source, input).errors.map(x => x.code)).toContain("MISSING_MAIN");
    expect(validateSolution(code.replace('hello world', '} \\" ('), input).errors).toEqual([]);
  });
  it("accepts legal modifier ordering", () => {
    expect(validateSolution(code.replace('public static void', 'static public final void'), input).errors).toEqual([]);
  });
  it("makes approximate metrics and missing constructs warnings", () => {
    const request = { ...input,
      mandatory: [{ title: "Test", fields: [{ label: "Code", value: 'for(int i=0;i<5;i++)' }] }],
      complexity: [{ title: "Limits", fields: [{ label: "Token Count", value: "1" }] }]
    };
    const checked = validateSolution(code, request);
    expect(checked.errors).toEqual([]);
    expect(checked.warnings.map(x => x.code)).toEqual(["MANDATORY_FRAGMENT", "ESTIMATED_TOKEN_COUNT"]);
  });
  it("excludes descriptive metadata and matches tokens without mutating literals", () => {
    const request = { ...input, mandatory: [{ title: "Test", fields: [
      { label: "Description", value: "Use a loop (five times)." },
      { label: "Score", value: "10" },
      { label: "Statement", value: 'System.out.println("helloworld");' }
    ] }] };
    expect(mandatoryFragments(request)).toEqual(['System.out.println("helloworld");']);
    expect(validateSolution(code, request).warnings).toHaveLength(1);
    request.mandatory[0].fields[2].value = 'System . out . println ( "hello world" ) ;';
    expect(validateSolution(code, request).warnings).toEqual([]);
    expect(extractJavaCode(code)).toContain('"hello world"');
  });
});
