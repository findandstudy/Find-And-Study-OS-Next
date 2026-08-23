import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodError, type ZodTypeAny, type infer as zInfer } from "zod";

export interface ValidateSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Typed access to data validated by `validate()`.
 *
 * Route handlers should call `getValidated<{ body: BodySchema }>(req).body`
 * instead of casting `req.body`. Behind the scenes the parsed payloads are
 * stored on a non-enumerable symbol on the Request object so we never have
 * to mutate or `as any`-cast the express request.
 */
const VALIDATED = Symbol.for("workspace.validate.parsed");

type Parsed<S extends ValidateSchemas> = {
  [K in keyof S]: S[K] extends ZodTypeAny ? zInfer<S[K]> : never;
};

export function getValidated<S extends ValidateSchemas>(req: Request): Parsed<S> {
  const bag = (req as unknown as { [VALIDATED]?: Parsed<S> })[VALIDATED];
  if (!bag) throw new Error("validate() middleware did not run for this route");
  return bag;
}

function flattenZod(err: ZodError) {
  return err.issues.map((i) => ({
    path: i.path.join("."),
    message: i.message,
    code: i.code,
  }));
}

export function validate<S extends ValidateSchemas>(schemas: S): RequestHandler {
  const sources = ["body", "query", "params"] as const;
  return (req: Request, res: Response, next: NextFunction): void => {
    const parsed: Record<string, unknown> = {};
    for (const src of sources) {
      const schema = schemas[src];
      if (!schema) continue;
      const result = schema.safeParse(req[src]);
      if (!result.success) {
        res.status(400).json({
          error: "Validation failed",
          source: src,
          issues: flattenZod(result.error),
        });
        return;
      }
      parsed[src] = result.data;
    }
    Object.defineProperty(req, VALIDATED, {
      value: parsed,
      enumerable: false,
      writable: false,
      configurable: true,
    });
    next();
  };
}
