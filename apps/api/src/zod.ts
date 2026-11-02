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

/**
 * Validates request params, query, headers and body with zod, checks every
 * response against its schema, and refuses to start if a route has no
 * response schema.
 */
export function registerZod(app: FastifyInstance): void {
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler<z.ZodType>(
    ({ schema }) =>
      (data) =>
        JSON.stringify(schema.parse(data)),
  );
  app.addHook('onRoute', (route: RouteOptions) => {
    if (!route.schema?.response) {
      throw new Error(`Route ${String(route.method)} ${route.url} has no response schema.`);
    }
  });
}
