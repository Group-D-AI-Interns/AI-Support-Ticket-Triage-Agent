# Ticket AI foundation

The first milestone provides provider-neutral ticket classification and
summarization components, strict output validation, bounded execution retries,
timeouts, and metadata-only execution logging.

`TicketAiAnalysisService` accepts an `AuthorizedTicketAnalysisSource`. Its
implementation must use the authenticated caller's trusted `TenantContext` and
return a ticket only after the ticket module has enforced its access rules. The
TypeScript ticket API now exists, but it has only a development principal; no
production authorization-aware AI adapter or HTTP route is wired here.

No LLM provider is approved. `DeterministicFakeProvider` is for tests and local
contract verification only; it is not an AI model and must not be used as a
production provider. Classification categories and summarization information
to collect are supplied by the caller rather than hardcoded.

The document extraction worker now shares a batch adapter contract with the
provisional extractor. That extractor remains a deterministic local placeholder
and supports plain text only; it is not a production LLM integration.

`AiAnalysisRepository` is the persistence boundary. The shared TypeScript JSON
store currently cannot safely persist AI analyses and has no agreed atomic,
concurrent-write contract, so this milestone does not add a competing JSON
storage implementation. A tenant-scoped adapter and API/job integration remain
pending shared foundation decisions.
