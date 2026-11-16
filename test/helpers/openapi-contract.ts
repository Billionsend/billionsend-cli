import { readFileSync } from "node:fs";
import { Ajv2020, type ErrorObject, type ValidateFunction } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";

/**
 * The published BillionSend OpenAPI document (openapi/api.openapi.json, kept
 * in step by `pnpm openapi:sync`) as a request and response validator. The
 * contract API in contract-api.ts runs every request it receives and every
 * answer it gives through this, so a test passes only while the CLI speaks
 * the documented API and the fake answers the documented shapes.
 */

type Json = Record<string, unknown>;

interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required?: boolean;
  schema?: Json;
}

interface Operation {
  parameters?: Parameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: Json }> };
  responses: Record<string, { content?: Record<string, { schema?: Json }> }>;
  security?: unknown[];
}

export interface MatchedOperation {
  method: string;
  /** The path template as the document names it, e.g. /contacts/{id}. */
  template: string;
  params: Record<string, string>;
  operation: Operation;
  pointer: string;
}

export const SPEC_PATH = new URL("../../openapi/api.openapi.json", import.meta.url);

const spec = JSON.parse(readFileSync(SPEC_PATH, "utf8")) as {
  paths: Record<string, Record<string, Operation>>;
};

// ajv-formats is CommonJS; its default export arrives wrapped under ESM.
const addFormats = ((addFormatsModule as unknown as { default?: unknown }).default ??
  addFormatsModule) as (ajv: Ajv2020) => void;

const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: true });
addFormats(ajv);
ajv.addSchema(spec, "openapi.json");

const pointerSegment = (segment: string) => segment.replace(/~/g, "~0").replace(/\//g, "~1");

const compiled = new Map<string, ValidateFunction>();
function validatorAt(pointer: string): ValidateFunction {
  let fn = compiled.get(pointer);
  if (!fn) {
    fn = ajv.compile({ $ref: `openapi.json#${pointer}` });
    compiled.set(pointer, fn);
  }
  return fn;
}

const templates = Object.keys(spec.paths).map((template) => {
  const names: string[] = [];
  const source = template
    .split("/")
    .map((segment) => {
      const param = /^\{(.+)\}$/.exec(segment);
      if (!param?.[1]) return segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      names.push(param[1]);
      return "([^/]+)";
    })
    .join("/");
  // A literal segment beats a parameter: /contacts/batch is not /contacts/{id}.
  const literals = template.split("/").filter((s) => !s.startsWith("{")).length;
  return { template, names, re: new RegExp(`^${source}$`), literals };
});
templates.sort((a, b) => b.literals - a.literals);

/** Every (METHOD, template) the document holds. */
export function allOperations(): string[] {
  const out: string[] = [];
  for (const [template, ops] of Object.entries(spec.paths)) {
    for (const method of Object.keys(ops)) {
      if (method !== "parameters") out.push(`${method.toUpperCase()} ${template}`);
    }
  }
  return out;
}

/** The documented operation a request lands on, or null when the document has none. */
export function matchOperation(method: string, pathname: string): MatchedOperation | null {
  const lower = method.toLowerCase();
  for (const { template, names, re } of templates) {
    const m = re.exec(pathname);
    if (!m) continue;
    const operation = spec.paths[template]?.[lower];
    if (!operation) continue;
    const params: Record<string, string> = {};
    names.forEach((name, i) => {
      params[name] = decodeURIComponent(m[i + 1] ?? "");
    });
    return {
      method: method.toUpperCase(),
      template,
      params,
      operation,
      pointer: `/paths/${pointerSegment(template)}/${lower}`,
    };
  }
  return null;
}

const describe = (errors: ErrorObject[] | null | undefined, root: string): string[] =>
  (errors ?? []).map((e) => {
    const where = [root, ...e.instancePath.split("/").filter(Boolean)].filter(Boolean).join(".");
    const extra =
      e.keyword === "additionalProperties"
        ? ` (${String((e.params as { additionalProperty?: string }).additionalProperty)})`
        : e.keyword === "enum"
          ? ` (${JSON.stringify((e.params as { allowedValues?: unknown }).allowedValues)})`
          : "";
    return `${where ? `${where}: ` : ""}${e.message ?? e.keyword}${extra}`;
  });

const coerce = (raw: string, schema: Json | undefined): unknown => {
  const type = schema?.type;
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("integer") || types.includes("number")) {
    const n = Number(raw);
    return Number.isFinite(n) && raw.trim() !== "" ? n : raw;
  }
  if (types.includes("boolean")) return raw === "true" ? true : raw === "false" ? false : raw;
  return raw;
};

export interface RequestProblems {
  /** The request does not fit the document: unknown query or header parameter, wrong type, bad body. */
  problems: string[];
  /** Problems in the JSON body alone, as `field: message` (the API's 422 wording). */
  bodyProblems: string[];
}

/** Parameters and body against the operation. Unknown query parameters are problems too. */
export function checkRequest(
  matched: MatchedOperation,
  url: URL,
  headers: Record<string, string | undefined>,
  body: unknown,
  hasBody: boolean,
): RequestProblems {
  const problems: string[] = [];
  const params = matched.operation.parameters ?? [];
  params.forEach((param, i) => {
    let raw: string | undefined;
    if (param.in === "path") raw = matched.params[param.name];
    else if (param.in === "query") raw = url.searchParams.get(param.name) ?? undefined;
    else raw = headers[param.name.toLowerCase()];
    if (raw === undefined) {
      if (param.required) problems.push(`${param.in} parameter ${param.name} is required`);
      return;
    }
    const validate = validatorAt(`${matched.pointer}/parameters/${i}/schema`);
    if (!validate(coerce(raw, param.schema))) {
      problems.push(...describe(validate.errors, `${param.in}.${param.name}`));
    }
  });
  const known = new Set(params.filter((p) => p.in === "query").map((p) => p.name));
  for (const name of url.searchParams.keys()) {
    if (!known.has(name)) problems.push(`query parameter ${name} is not documented`);
  }
  const bodyProblems: string[] = [];
  const content = matched.operation.requestBody?.content?.["application/json"];
  if (content?.schema) {
    if (!hasBody) {
      if (matched.operation.requestBody?.required) bodyProblems.push("body is required");
    } else {
      const validate = validatorAt(
        `${matched.pointer}/requestBody/content/application~1json/schema`,
      );
      // A batch (an operation taking x-batch-validation) checks each item itself, so that header
      // can decide between failing the batch and listing the item: item errors are its handler's.
      const perItem = params.some((p) => p.in === "header" && p.name === "x-batch-validation");
      const errors = validate(body)
        ? []
        : (validate.errors ?? []).filter((e) => !(perItem && /^\/\d+(\/|$)/.test(e.instancePath)));
      if (errors.length > 0) bodyProblems.push(...describe(errors, ""));
    }
  } else if (hasBody) {
    problems.push("the operation documents no request body");
  }
  return { problems, bodyProblems };
}

/** Problems with an answer: a status the operation does not document, or a body off its schema. */
export function checkResponse(matched: MatchedOperation, status: number, body: unknown): string[] {
  // Every authenticated operation may answer 401 (bearerAuth) and 429 (rate limit).
  const documented = matched.operation.responses[String(status)];
  if (!documented) {
    if (status === 401 || status === 429) return [];
    return [`status ${status} is not documented`];
  }
  if (!documented.content?.["application/json"]?.schema) return [];
  const validate = validatorAt(
    `${matched.pointer}/responses/${status}/content/application~1json/schema`,
  );
  return validate(body) ? [] : describe(validate.errors, "response");
}

/** A value against one named component schema (for per-item checks the document leaves open). */
export function checkComponent(name: string, value: unknown): string[] {
  const validate = validatorAt(`/components/schemas/${pointerSegment(name)}`);
  return validate(value) ? [] : describe(validate.errors, "");
}
