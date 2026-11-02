import type {
  FastifyInstance,
  FastifySchemaCompiler,
  FastifyTypeProvider,
  RouteOptions,
} from 'fastify';
import { z } from 'zod';

/** Lets route handlers see the types of their zod schemas. */
export interface ZodTypeProvider extends FastifyTypeProvider {
  validator: this['schema'] extends z.ZodType ? z.output<this['schema']> : unknown;
  serializer: this['schema'] extends z.ZodType ? z.input<this['schema']> : unknown;
}

const validatorCompiler: FastifySchemaCompiler<z.ZodType> =
  ({ schema }) =>
  (data) => {
    const result = schema.safeParse(data);
    return result.success ? { value: result.data } : { error: result.error };
  };

const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);

/**
 * Validates request params, query, headers and body with zod and checks every
 * response against its schema. Refuses to start if a route is missing the
 * response schema, the body schema of a write, or the params schema of a path
 * with parameters.
 */
export function registerZod(app: FastifyInstance): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler<z.ZodType>(
    ({ schema }) =>
      (data) =>
        JSON.stringify(schema.parse(data)),
  );
  app.addHook('onRoute', (route: RouteOptions) => {
    const name = `${String(route.method)} ${route.url}`;
    const methods = [route.method].flat();
    if (!route.schema?.response) throw new Error(`Route ${name} has no response schema.`);
    if (methods.some((m) => BODY_METHODS.has(m)) && !route.schema.body) {
      throw new Error(`Route ${name} has no body schema.`);
    }
    if (route.url.includes(':') && !route.schema.params) {
      throw new Error(`Route ${name} has no params schema.`);
    }
  });
}
