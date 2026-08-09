/**
 * Prompt templates for each generation stage.
 * These are used by the stage functions to construct LLM requests.
 */


export const PROMPTS = {
  stage1_survey: `You are a senior software architect performing a codebase audit.
Your task is to categorize this project based on the analysis data provided.

Respond with a JSON object containing:
- projectCategory: One of ["web-frontend", "web-backend", "api-service", "cli-tool", "library", "mobile-app", "desktop-app", "data-pipeline", "ml-service", "monorepo", "other"]
- primaryLanguage: The main language
- frameworks: Array of detected frameworks
- architecturePattern: One of ["layered", "hexagonal", "microservices", "monolith", "serverless", "event-driven", "mvc", "other"]
- domainSummary: One sentence describing what this system does
- suggestedDomains: Array of domain names for OpenSpec specs (e.g., ["user", "order", "auth", "api"])
- confidence: 0-1 score of how confident you are
- schemaFiles: Array of file paths (from the provided file list) that define data models, types, entities, or interfaces — these will be used for entity extraction. Include files regardless of their name, based on their content role.
- serviceFiles: Array of file paths containing business logic, services, processors, analyzers, pipelines, or domain operations — used for service analysis. Do not filter by name conventions; look at what the file does.
- apiFiles: Array of file paths that expose public interfaces: HTTP routes, CLI command handlers, GraphQL resolvers, message consumers, or external-facing APIs.

For schemaFiles/serviceFiles/apiFiles: use the exact file paths from the provided analysis. Return [] if none apply.

Example output:
{
  "projectCategory": "api-service",
  "primaryLanguage": "TypeScript",
  "frameworks": ["Express", "Prisma"],
  "architecturePattern": "layered",
  "domainSummary": "REST API managing e-commerce orders and inventory.",
  "suggestedDomains": ["order", "product", "auth"],
  "confidence": 0.85,
  "schemaFiles": ["src/models/order.ts", "src/types/product.ts"],
  "serviceFiles": ["src/services/order-service.ts", "src/core/inventory.ts"],
  "apiFiles": ["src/routes/orders.ts", "src/cli/commands/create.ts"]
}

Respond ONLY with valid JSON.`,

  stage2_entities: `You are analyzing the core data models described by the provided project data.

For each entity you identify, extract in OpenSpec format:
- name: The entity name (e.g., "User", "Order")
- description: What this entity represents in the business domain
- properties: Array of {name, type, description, required}
- relationships: Array of {targetEntity, type, description}
- validations: Array of validation rules as strings (these become Requirements)
- scenarios: Array of {name, given, when, then, and?} - observable behaviors in Given/When/Then format

Focus on BUSINESS entities, not framework internals.
Be precise - only include what you can verify from the code.

Example output:
[{
  "name": "Order",
  "description": "Represents a customer purchase transaction.",
  "properties": [
    {"name": "id", "type": "string", "description": "Unique identifier", "required": true},
    {"name": "status", "type": "OrderStatus", "description": "Current lifecycle state", "required": true}
  ],
  "relationships": [{"targetEntity": "User", "type": "belongs-to", "description": "Order belongs to a customer"}],
  "validations": ["Total must be positive", "Status transitions: pending → confirmed → shipped"],
  "scenarios": [{"name": "Place order", "given": "User with items in cart", "when": "submitOrder() is called", "then": "Order created with status 'pending' and inventory reserved"}],
  "location": ""
}]

Respond with a JSON array of entities. Respond ONLY with valid JSON.`,

  stage3_services: `You are analyzing the logic and processing layer described by the provided project data.

For each service/module, identify:
- name: Service name
- purpose: What capability or responsibility it encapsulates
- operations: Array of {name, description, inputs, outputs, scenarios, functionName} - key operations/methods that become Requirements with Scenarios. Cover all meaningful operations that represent distinct business behaviors.
  - operations[].functionName: The exact function or method name as written in the source code that implements this operation (e.g. "runStage2", "buildSpecMap"). Leave empty string if uncertain.
- dependencies: Array of other services/repositories it uses
- sideEffects: Array of external interactions (file I/O, network calls, database, queues, etc.)
- domain: Which domain OWNS this service (where it lives in the codebase, not who uses it) — use ONLY one of the available domains listed above

Focus on WHAT the service does, not HOW it's implemented.
Express operations as requirements (SHALL/MUST/SHOULD) with testable scenarios.

Example output:
[{
  "name": "OrderService",
  "purpose": "Manages order lifecycle: placement, validation, and fulfillment.",
  "operations": [
    {
      "name": "placeOrder",
      "description": "Validates cart contents and creates a new order record.",
      "inputs": ["userId: string", "items: CartItem[]"],
      "outputs": ["orderId: string"],
      "functionName": "placeOrder",
      "scenarios": [{"name": "Valid order", "given": "In-stock items in cart", "when": "placeOrder is called", "then": "Order persisted and inventory reserved"}]
    }
  ],
  "dependencies": ["InventoryService", "OrderRepository"],
  "sideEffects": ["Writes to orders table", "Sends confirmation email via queue"],
  "domain": "order"
}]

Respond with a JSON array of services. Respond ONLY with valid JSON.`,

  stage4_api: `Extract the public API surface of this application.

For each endpoint/interface, structure as:
- method: HTTP method or interface type
- path: Route path or interface signature
- purpose: What it does (becomes requirement description)
- authentication: Required auth (if detectable)
- requestSchema: Expected input as JSON object
- responseSchema: Expected output as JSON object
- scenarios: Array of {name, given, when, then, and?} - example request/response flows
- relatedEntity: Which domain entity it operates on

Example output:
[{
  "method": "POST",
  "path": "/api/orders",
  "purpose": "Create a new order from the current cart.",
  "authentication": "Bearer JWT",
  "requestSchema": {"userId": "string", "items": "CartItem[]"},
  "responseSchema": {"orderId": "string", "status": "pending"},
  "scenarios": [{"name": "Create order", "given": "Authenticated user with valid cart", "when": "POST /api/orders is called", "then": "201 Created with orderId in response body"}],
  "relatedEntity": "Order"
}]

Respond with a JSON array of endpoints. Respond ONLY with valid JSON.`,

  stage5_architecture: `Based on the provided analysis data, synthesize a complete architecture overview for OpenSpec.

Include:
- systemPurpose: 2-3 sentences on what this system does and why
- architectureStyle: The overall architecture pattern with justification
- layerMap: Array of {name, purpose, components} - how code is organized
- dataFlow: How data moves through the system (entry to persistence) as a string
- integrations: Array of external systems this interacts with
- securityModel: Authentication/authorization approach as a string
- keyDecisions: Array of observable architectural decisions as strings

Express each key architectural aspect clearly.
Base all conclusions on the code evidence provided.
Where uncertain, say so explicitly.

Example output:
{
  "systemPurpose": "A REST API for e-commerce order management. It allows customers to browse products, place orders, and track fulfillment.",
  "architectureStyle": "Layered architecture: HTTP routes → service layer → repository pattern over PostgreSQL.",
  "layerMap": [
    {"name": "API", "purpose": "HTTP routing and input validation", "components": ["routes/orders.ts", "routes/products.ts"]},
    {"name": "Service", "purpose": "Business logic and orchestration", "components": ["services/order-service.ts"]}
  ],
  "dataFlow": "HTTP request → route handler → service → repository → PostgreSQL; async email notifications via Redis queue",
  "integrations": ["PostgreSQL", "Redis", "SendGrid"],
  "securityModel": "JWT Bearer tokens issued at login; route middleware enforces authentication on all /api/* routes",
  "keyDecisions": ["Use Prisma ORM for type-safe database access", "Redis queue for async email notifications to avoid request latency"]
}

Respond with a JSON object. Respond ONLY with valid JSON.`,

  stage6_adr: `You are a senior software architect creating Architecture Decision Records (ADRs).

For each key decision listed below, produce a complete ADR with:
- id: Sequential like "ADR-001", "ADR-002", etc.
- title: The decision as a clear statement (e.g., "Use TypeORM for database access")
- status: "accepted" (these are observed decisions already implemented in the code)
- context: 2-3 sentences on why this decision was needed
- decision: 1-2 sentences clearly stating what was decided
- consequences: Array of 2-4 consequences (include both positive and negative)
- alternatives: Array of 1-3 alternatives that could have been chosen instead
- relatedLayers: Array of architecture layer names affected
- relatedDomains: Array of domain names affected

Base all conclusions on the code evidence provided. Where uncertain, say so explicitly.
Respond with a JSON array of ADR objects. Respond ONLY with valid JSON.`,

  stage3_subspec_system: `You are generating sub-specifications for the logical blocks of an orchestrator function.

For each sub-block provided, generate a focused specification:
- name: short camelCase identifier (e.g. "entityExtraction", "schemaValidation")
- callee: exact function/method name as written in source code
- purpose: one sentence describing what this block does
- operations: array of {name, description, inputs, outputs, scenarios, functionName}
  - Express operations as requirements using SHALL/MUST/SHOULD keywords
  - Include at least one testable scenario per operation

Focus on WHAT each block does, not HOW it is implemented.
Respond ONLY with a valid JSON array of sub-specification objects.`,

  stage3_subspec: (
    orchestratorName: string,
    orchestratorPurpose: string,
    callees: Array<{ name: string; signature?: string; docstring?: string; subcallees: string[] }>
  ) => `Orchestrator function: ${orchestratorName}
Purpose: ${orchestratorPurpose}

Sub-blocks to specify:
${callees.map((c, i) =>
  `${i + 1}. ${c.name}` +
  (c.signature ? `\n   Signature: ${c.signature}` : '') +
  (c.docstring ? `\n   Doc: ${c.docstring}` : '') +
  (c.subcallees.length > 0 ? `\n   Calls: ${c.subcallees.join(', ')}` : '')
).join('\n')}

Generate one sub-specification per sub-block listed above.
Respond ONLY with a valid JSON array of {name, callee, purpose, operations} objects.`,
};
