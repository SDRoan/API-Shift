/**
 * Shared domain types. This file is the contract between modules and holds no
 * behaviour. See DESIGN.md sections 3 and 4 for the reasoning behind it.
 */

export type Confidence = 'high' | 'medium' | 'low';

/** Whether a field level change affects what we send or what we read back. */
export type Direction = 'request' | 'response';

export type HttpMethod =
  | 'get'
  | 'put'
  | 'post'
  | 'delete'
  | 'options'
  | 'head'
  | 'patch'
  | 'trace';

export type ChangeKind =
  | 'operation.removed'
  | 'operation.added'
  | 'path.renamed'
  | 'param.removed'
  | 'param.added.required'
  | 'param.became.required'
  | 'param.renamed'
  | 'param.type.changed'
  | 'request.field.removed'
  | 'request.field.added.required'
  | 'request.field.became.required'
  | 'request.field.renamed'
  | 'request.field.type.changed'
  | 'response.field.removed'
  | 'response.field.renamed'
  | 'response.field.type.changed'
  | 'response.status.removed'
  /** The base URL moved. Catastrophic and otherwise invisible. */
  | 'server.url.changed'
  | 'server.removed'
  | 'server.added'
  /** Authentication requirements moved. */
  | 'security.added'
  | 'security.removed'
  | 'security.scheme.changed'
  /** An early warning, not yet a break. */
  | 'operation.deprecated'
  /** A request or response media type appeared or disappeared. */
  | 'content.type.removed'
  | 'content.type.added'
  | 'enum.value.removed'
  | 'enum.value.added';

export type ChangeLocation = 'path' | 'query' | 'header' | 'body' | 'response' | 'server' | 'security';

/** What moved, for renames and type changes. */
export interface ChangeTarget {
  location: ChangeLocation;
  from?: string;
  to?: string;
  fromType?: string;
  toType?: string;
}

/** One classified difference between two spec versions. */
export interface ApiChange {
  /** Stable id derived from kind, path, method, and target. Used to join sites and edits. */
  id: string;
  kind: ChangeKind;
  breaking: boolean;
  /** How sure the differ is. Observed changes are high, inferred renames may be lower. */
  confidence: Confidence;
  direction?: Direction;
  path: string;
  method?: HttpMethod;
  operationId?: string;
  target?: ChangeTarget;
  /** One line human readable description, used in reports and PR bodies. */
  detail: string;
}

export interface SpecDiff {
  oldVersion: string;
  newVersion: string;
  oldSource: string;
  newSource: string;
  generatedAt: string;
  changes: ApiChange[];
}

export type SiteStrategy =
  | 'url.literal'
  | 'url.template'
  | 'request.payload'
  | 'response.member'
  /** A property on a type declared in the target repo, reached through the payload's declared type. */
  | 'response.type'
  | 'client.method';

/** A location in the target repo affected by one ApiChange. */
export interface CallSite {
  changeId: string;
  /** Repo relative path. */
  file: string;
  line: number;
  column: number;
  strategy: SiteStrategy;
  confidence: Confidence;
  /** The source text of the matched node, for reports and PR bodies. */
  snippet: string;
}

export type EditAction = 'apply' | 'review';

/** A single proposed change to the target repo, with its routing decision. */
export interface ProposedEdit {
  changeId: string;
  site: CallSite;
  /** Codemod name, or 'llm' for a drafted suggestion. */
  strategy: string;
  /** min(changeConfidence, siteConfidence, strategyConfidence). */
  confidence: Confidence;
  /** 'apply' only when confidence is high. Everything else is 'review'. */
  action: EditAction;
  before: string;
  after?: string;
  reasoning: string;
}

export interface RunResult {
  runId: number;
  diff: SpecDiff;
  sites: CallSite[];
  edits: ProposedEdit[];
  prUrl?: string;
}
