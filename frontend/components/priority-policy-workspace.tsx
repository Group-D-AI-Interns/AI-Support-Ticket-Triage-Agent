"use client";

import { useCallback, useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { CompactItems } from "@/components/compact-items";
import { api, type PriorityMatrix, type PriorityPolicyConfiguration, type TenantDocument, type TenantDocumentVersion } from "@/lib/api";

const impactFactors = ["critical", "high", "medium", "low"] as const;
const urgencyFactors = ["immediate", "high", "medium", "low"] as const;
const priorities = ["P1", "P2", "P3", "P4"] as const;
type MatrixInput = Record<(typeof impactFactors)[number], Record<(typeof urgencyFactors)[number], (typeof priorities)[number] | "">>;
const blankMatrix = (): MatrixInput => Object.fromEntries(impactFactors.map(impact => [impact, Object.fromEntries(urgencyFactors.map(urgency => [urgency, ""]))])) as MatrixInput;
const messageOf = (error: unknown) => error instanceof Error ? error.message : "Priority policy request failed.";

export function PriorityPolicyWorkspace({ onError }: { onError: (error: unknown) => void }) {
  const [documents, setDocuments] = useState<TenantDocument[]>([]);
  const [versions, setVersions] = useState<TenantDocumentVersion[]>([]);
  const [policies, setPolicies] = useState<PriorityPolicyConfiguration[]>([]);
  const [documentId, setDocumentId] = useState("");
  const [versionId, setVersionId] = useState("");
  const [matrix, setMatrix] = useState(blankMatrix);
  const [reason, setReason] = useState("");
  const [decisionReasons, setDecisionReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState("");
  const [errorText, setErrorText] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setErrorText("");
    const results = await Promise.allSettled([api.documents(), api.priorityPolicies()]);
    if (results[0].status === "fulfilled") setDocuments(results[0].value.data);
    else { setErrorText(`Source documents: ${messageOf(results[0].reason)}`); onError(results[0].reason); }
    const policyResult = results[1];
    if (policyResult.status === "fulfilled") setPolicies(policyResult.value.data);
    else { setErrorText(current => [current, `Priority rules: ${messageOf(policyResult.reason)}`].filter(Boolean).join(" · ")); onError(policyResult.reason); }
    setLoading(false);
  }, [onError]);
  useEffect(() => { void load(); }, [load]);

  async function selectDocument(id: string) {
    setDocumentId(id); setVersionId(""); setVersions([]);
    if (!id) return;
    try {
      const result = await api.document(id);
      setVersions(result.data.versions.filter(version => version.documentId === id && version.organisationId === result.data.document.organisationId));
    } catch (error) { setErrorText(messageOf(error)); onError(error); }
  }
  async function create(event: React.FormEvent) {
    event.preventDefault();
    if (impactFactors.some(impact => urgencyFactors.some(urgency => !matrix[impact]?.[urgency]))) return;
    setBusy(true); setErrorText("");
    try {
      await api.createPriorityPolicy({ matrix: matrix as PriorityMatrix, sourceDocumentId: documentId, sourceDocumentVersionId: versionId, reason: reason.trim() });
      setMatrix(blankMatrix()); setReason(""); setFeedback("A new immutable priority policy draft was created. Review and approve it before activation."); await load();
    } catch (error) { setErrorText(messageOf(error)); onError(error); }
    finally { setBusy(false); }
  }
  async function decide(policy: PriorityPolicyConfiguration, action: "approve" | "activate") {
    const why = (decisionReasons[policy.id] ?? "").trim(); if (!why) return;
    setBusy(true); setErrorText("");
    try { await api.decidePriorityPolicy(policy.id, action, why); setDecisionReasons(current => ({ ...current, [policy.id]: "" })); setFeedback(action === "approve" ? `Version ${policy.data.version} approved. Activate it separately when ready.` : `Version ${policy.data.version} activated; the previous active version was archived.`); await load(); }
    catch (error) { setErrorText(messageOf(error)); onError(error); }
    finally { setBusy(false); }
  }
  const readyDocuments = documents.filter(document => document.status === "processed" && document.processingStatus === "completed");
  return <section className="content-card config-priority-card">
    <div className="policy-section-heading"><div><h3>Priority scoring policy</h3><p className="muted-copy">Create an immutable version from a processed organisation document. Approval and activation are separate audited actions.</p></div><button className="button button-secondary" type="button" onClick={() => void load()} disabled={loading || busy}><Activity size={14}/> Refresh</button></div>
    {feedback && <p className="config-notice" role="status">{feedback}</p>}{errorText && <p className="config-error" role="alert">{errorText}</p>}
    <form className="policy-form config-priority-form" onSubmit={event => void create(event)}>
      <div className="policy-form-two"><label className="field"><span>Processed source document</span><select required value={documentId} onChange={event => void selectDocument(event.target.value)}><option value="">Select a verified document</option>{readyDocuments.map(document => <option key={document.id} value={document.id}>{document.title} · {document.fileName}</option>)}</select></label>
        <label className="field"><span>Source version</span><select required value={versionId} onChange={event => setVersionId(event.target.value)} disabled={!versions.length}><option value="">Select version</option>{versions.map(version => <option key={version.id} value={version.id}>Version {version.version} · {version.fileName}</option>)}</select></label></div>
      <div className="priority-matrix" role="group" aria-label="Priority scoring matrix"><div className="priority-matrix-title"><strong>Business impact × urgency</strong><span>Impact rows · urgency columns</span></div><div className="priority-matrix-grid"><span aria-hidden="true"/>{urgencyFactors.map(urgency => <strong key={urgency}>Urgency {urgency}</strong>)}{impactFactors.map(impact => <div className="priority-matrix-row" key={impact}><strong>Impact {impact}</strong>{urgencyFactors.map(urgency => <label className="field" key={urgency}><span className="visually-hidden">Impact {impact}, urgency {urgency}</span><select required value={matrix[impact]?.[urgency] ?? ""} onChange={event => setMatrix(current => ({ ...current, [impact]: { ...current[impact], [urgency]: event.target.value as MatrixInput[typeof impact][typeof urgency] } }))}><option value="">Choose</option>{priorities.map(priority => <option key={priority}>{priority}</option>)}</select></label>)}</div>)}</div></div>
      <label className="field"><span>Draft reason</span><textarea rows={2} required maxLength={2000} value={reason} onChange={event => setReason(event.target.value)} /></label>
      <button className="button button-primary" disabled={busy || loading || !documentId || !versionId || !reason.trim() || impactFactors.some(impact => urgencyFactors.some(urgency => !matrix[impact]?.[urgency]))}>Create versioned draft</button>
      {!readyDocuments.length && <p className="muted-copy">No processed source documents are available. Upload and process the approved policy document in Documents first.</p>}
    </form>
    {loading ? <p role="status" className="muted-copy">Loading priority policy versions?</p> : policies.length ? <div className="candidate-list config-priority-versions"><CompactItems items={policies} label="priority policy versions" initialCount={3} getKey={policy => policy.id} renderItem={policy => <article className="config-priority-version">
      <div className="policy-section-heading"><strong>Version {policy.data.version}</strong><span className={`policy-status policy-status-${policy.data.status}`}>{policy.data.status.replaceAll("_", " ")}</span></div>
      <p className="config-priority-source">Source: {documents.find(document => document.id === policy.data.sourceDocumentId)?.title ?? policy.data.sourceDocumentId}</p>
      <details className="config-priority-version-details"><summary>Version details and actions</summary><div className="config-priority-version-body">
        <p className="muted-copy">Immutable source checksum: {policy.data.sourceChecksumSha256}</p>
        <p className="muted-copy">Draft reason: {policy.data.reason}{policy.data.approvalReason ? ` ? Approval: ${policy.data.approvalReason}` : ""}{policy.data.activationReason ? ` ? Activation: ${policy.data.activationReason}` : ""}</p>
        {(policy.data.status === "draft" || policy.data.status === "approved") && <div className="policy-review-actions"><label className="field"><span>{policy.data.status === "draft" ? "Approval reason" : "Activation reason"}</span><input required value={decisionReasons[policy.id] ?? ""} onChange={event => setDecisionReasons(current => ({ ...current, [policy.id]: event.target.value }))}/></label>{policy.data.status === "draft" ? <button type="button" className="button button-primary button-small" disabled={busy || !(decisionReasons[policy.id] ?? "").trim()} onClick={() => void decide(policy, "approve")}>Approve version</button> : <button type="button" className="button button-primary button-small" disabled={busy || !(decisionReasons[policy.id] ?? "").trim()} onClick={() => void decide(policy, "activate")}>Activate version</button>}</div>}
      </div></details>
    </article>}/></div> : <p className="muted-copy">No priority policy versions configured.</p>}
    <p className="muted-copy">Recommendations use an explicitly configured confidence threshold and always require human review. Priority changes to tickets remain a separately authorized action.</p>
  </section>;
}
