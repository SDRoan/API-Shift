/**
 * Spec loading. The only impure part of the differ, isolated here so the walk
 * itself stays a pure function over two models.
 */

import SwaggerParser from '@apidevtools/swagger-parser';
import type { OpenAPI, OpenAPIV3 } from 'openapi-types';

export interface LoadedSpec {
  /** The path or URL it came from, echoed into reports and the pull request body. */
  source: string;
  title: string;
  version: string;
  /** First declared server, which is the one clients actually call. */
  primaryServer?: string | undefined;
  document: OpenAPIV3.Document;
}

export class SpecLoadError extends Error {
  constructor(source: string, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(`failed to load spec from ${source}: ${reason}`);
    this.name = 'SpecLoadError';
  }
}

function isOpenApiV3(document: OpenAPI.Document): document is OpenAPIV3.Document {
  return 'openapi' in document && typeof document.openapi === 'string';
}

/**
 * Parse and fully dereference a spec. Dereferencing up front means the diff walk
 * never chases a $ref, which removes a whole class of bugs from every module
 * downstream.
 *
 * `source` may be a local file path, a URL, or an already parsed document, which
 * is what tests use.
 */
export interface LoadSpecOptions {
  /**
   * Whether `$ref` may point at another file or URL.
   *
   * On by default, since real specs use it. A public endpoint must turn it off:
   * the URL was supplied by a stranger, and a spec that references
   * http://169.254.169.254/ would otherwise make the server fetch it, walking
   * straight past every guard on the original URL.
   */
  allowExternalRefs?: boolean | undefined;
}

export async function loadSpec(
  source: string | OpenAPI.Document,
  options: LoadSpecOptions = {},
): Promise<LoadedSpec> {
  const label = typeof source === 'string' ? source : 'inline document';

  let document: OpenAPI.Document;
  try {
    // Clone, because dereference mutates the document it is given.
    const input = typeof source === 'string' ? source : structuredClone(source);
    document = await SwaggerParser.dereference(
      input,
      options.allowExternalRefs === false
        ? { resolve: { external: false } }
        : {},
    );
  } catch (error: unknown) {
    throw new SpecLoadError(label, error);
  }

  if (!isOpenApiV3(document)) {
    throw new SpecLoadError(
      label,
      new Error('only OpenAPI 3.x is supported, Swagger 2.0 documents are not'),
    );
  }

  const primaryServer = document.servers?.[0]?.url;

  return {
    source: label,
    title: document.info?.title ?? 'untitled api',
    version: document.info?.version ?? 'unknown',
    ...(primaryServer !== undefined ? { primaryServer } : {}),
    document,
  };
}
