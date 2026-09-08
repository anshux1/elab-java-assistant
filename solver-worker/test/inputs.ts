import { solveRequestSchema } from "../src/schema";
export const code = 'public final class Main { public static void main(String[] args) { System.out.println("hello world"); } }';
export const input = solveRequestSchema.parse({ language: "Java 11", starterCode: "public class Main { public static void main(String[] args) {} }", problem: "Print hello world." });
export const env = { OLLAMA_API_KEY: "test-only-key", OLLAMA_MODEL: "gpt-oss:120b" };
export const answer = (content = code, extra = {}) => ({ model: "gpt-oss:120b", message: { role: "assistant", content }, done: true, done_reason: "stop", prompt_eval_count: 10, eval_count: 20, ...extra });
