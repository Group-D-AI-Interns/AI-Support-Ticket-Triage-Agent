# Data Flow Design

## 1. Document and policy ingestion

```mermaid
flowchart TD
  A[Admin selects document] --> B[API authenticates and authorises]
  B --> C[Validate file type, size and safety]
  C --> D[Private object storage]
  D --> E[Create document/version record]
  E --> F[Queue extraction job]
  F --> G[Text extraction and parsing]
  G --> H[AI identifies candidate rules]
  H --> I[Attach evidence, source page and confidence]
  I --> J[Admin review]
  J -->|Approve| K[Create approved rule version]
  J -->|Reject / revise| L[Record decision and return to draft]
  K --> M[Activate according to effective dates]
```

## 2. Ticket triage

```mermaid
sequenceDiagram
  actor Agent
  participant UI as Web UI
  participant API
  participant Ticket as Ticket Service
  participant AI as AI Orchestrator
  participant KB as Tenant Knowledge Retrieval
  participant Audit
  Agent->>UI: Submit or open ticket
  UI->>API: Create ticket / request analysis
  API->>Ticket: Validate and persist
  Ticket-->>API: Ticket ID
  API->>AI: Start triage with tenant context
  AI->>AI: Classify and summarise
  AI->>AI: Evaluate configured priority factors
  AI->>KB: Retrieve permitted similar evidence
  KB-->>AI: Relevant source references
  AI->>AI: Draft resolution and routing suggestions
  AI->>Audit: Record execution and recommendation
  AI-->>API: Structured recommendations
  API-->>UI: Results and review requirements
  Agent->>UI: Review / edit / approve / reject
  UI->>API: Submit decision
  API->>Audit: Persist reviewer decision
```

## 3. SLA monitoring

```mermaid
flowchart TD
  A[Ticket event or scheduled evaluation] --> B[Load tenant and ticket]
  B --> C[Resolve applicable approved SLA version]
  C --> D[Apply business calendar and priority]
  D --> E[Calculate response/resolution deadlines]
  E --> F[Compare reliable timestamps to deadlines]
  F --> G[Persist evaluation and risk]
  G --> H{Escalation threshold reached?}
  H -->|Yes| I[Create governed escalation/notification]
  H -->|No| J[Continue monitoring]
```


```mermaid
flowchart TD
  A[Assessment period starts] --> B[Load approved role assignments]
  B --> C[Collect configured data sources]
  C --> D[Validate measurements and provenance]
  F --> G[Calculate overall result]
  G --> H[Persist snapshot and audit metadata]
  H --> I[Role-authorised dashboard and review]
```

## 5. Data classification and protection

| Data | Handling |
|---|---|
| Tenant policies and uploaded documents | Private storage, tenant scope, document-level permissions |
| Tickets and attachments | Tenant/ownership scope, least-privilege access, retention controls |
| AI prompts and retrieved evidence | Minimise/redact sensitive content; permission-filter before retrieval |
| Employee performance records | Restricted role access, auditable changes and retention policy |
| Audit records | Append-oriented access, restricted visibility and tamper-resistance appropriate to deployment |
| Secrets | Secret manager/environment; never source control or client bundle |
