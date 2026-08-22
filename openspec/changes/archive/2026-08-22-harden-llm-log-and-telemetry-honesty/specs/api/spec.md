# api spec delta

## MODIFIED Requirements

### Requirement: Postspecverification

The API SHALL support `POST /api/verify` to verify generated specs against actual source code.

**Request:**

```json
{
  "rootPath": "string",
  "samples": "number",
  "threshold": "number",
  "provider": "string",
  "model": "string",
  "apiBase": "string",
  "sslVerify": "boolean",
  "openaiCompatBaseUrl": "string",
  "onProgress": "function"
}
```

**Response:**

```json
{
  "report": "object",
  "duration": "number"
}
```

#### Scenario: VerifySpecs
- **GIVEN** Valid openlore configuration, existing specs, and LLM API key
- **WHEN** POST /api/verify is called with valid parameters
- **THEN** 200 OK with verification report and duration
- **AND** Progress updates are sent via onProgress callback
- **AND** LLM logs are saved only when `OPENLORE_LLM_LOGS=1`

#### Scenario: MissingConfiguration
- **GIVEN** No openlore configuration exists
- **WHEN** POST /api/verify is called
- **THEN** 400 Bad Request with error message

#### Scenario: MissingSpecs
- **GIVEN** No specs exist in the expected location
- **WHEN** POST /api/verify is called
- **THEN** 400 Bad Request with error message

#### Scenario: MissingLlmApiKey
- **GIVEN** No LLM API key is set in environment variables
- **WHEN** POST /api/verify is called
- **THEN** 400 Bad Request with error message
